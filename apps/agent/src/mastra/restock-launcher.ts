import type { Mastra } from '@mastra/core';
import { GmailNewMessageEventSchema } from '@ops/connector-composio';
import { z } from 'zod';

export const RESTOCK_WORKFLOW_KEY = 'restockWorkflow';
export const RESTOCK_WORKFLOW_ID = 'restock';
export const VENDOR_REPLY_WORKFLOW_KEY = 'vendorReplyWorkflow';
export const VENDOR_REPLY_WORKFLOW_ID = 'vendor-reply';

/** Workflows that suspend on `await-decision` for a proposal: workflow id (proposal `meta.workflowId`) → Mastra key. */
export const DECISION_WORKFLOWS = {
  [RESTOCK_WORKFLOW_ID]: RESTOCK_WORKFLOW_KEY,
  [VENDOR_REPLY_WORKFLOW_ID]: VENDOR_REPLY_WORKFLOW_KEY,
} as const;
export type DecisionWorkflowId = keyof typeof DECISION_WORKFLOWS;
export const isDecisionWorkflowId = (id: unknown): id is DecisionWorkflowId => typeof id === 'string' && Object.hasOwn(DECISION_WORKFLOWS, id);

/** What starts a restock run: who/what triggered it and an optional scope. */
export const RestockTriggerSchema = z
  .object({
    triggeredBy: z.string().min(1).max(200).describe('e.g. user:<email>, cron, webhook:distru, agent:ops-lead'),
    scenarioNote: z.string().max(1000).optional().describe('Free-form note from the operator, passed to the agents'),
    locationIds: z.array(z.string().min(1)).max(20).optional(),
    vendorIds: z.array(z.string().min(1)).max(50).optional(),
    productIds: z.array(z.string().min(1)).max(100).optional(),
  })
  .meta({ id: 'RestockTrigger' });
export type RestockTrigger = z.infer<typeof RestockTriggerSchema>;

/** The resume nudge sent after a decision. The step re-reads the proposal; this is only a hint. */
export const RestockResumeSchema = z
  .object({ decision: z.enum(['approve', 'reject']).optional(), by: z.string().optional() })
  .meta({ id: 'RestockResume' });
export type RestockResume = z.infer<typeof RestockResumeSchema>;

export const AWAIT_DECISION_STEP = 'await-decision';

export interface StartedRun {
  runId: string;
}

/**
 * Starts and resumes restock runs on whatever engine the registered workflow uses (Inngest in the
 * server, the default engine in tests). Bound to the Mastra instance after construction, which
 * breaks the import cycle agents → launcher → mastra → agents.
 */
export class RestockLauncher {
  #mastra: Mastra | null = null;

  bind(mastra: Mastra): this {
    this.#mastra = mastra;
    return this;
  }

  get mastra(): Mastra {
    if (!this.#mastra) throw new Error('RestockLauncher is not bound to a Mastra instance');
    return this.#mastra;
  }

  workflow() {
    return this.mastra.getWorkflow(RESTOCK_WORKFLOW_KEY);
  }

  /** A workflow that waits on a proposal decision, by its workflow id (`restock`, `vendor-reply`). */
  decisionWorkflow(id: DecisionWorkflowId) {
    return this.mastra.getWorkflow(DECISION_WORKFLOWS[id]);
  }

  /** Starts a vendor-reply run for a (verified, normalized) Composio Gmail event. Fire-and-forget. */
  async startVendorReply(event: unknown, options: { runId?: string } = {}): Promise<StartedRun> {
    const workflow = this.decisionWorkflow(VENDOR_REPLY_WORKFLOW_ID);
    const run = await workflow.createRun(options.runId ? { runId: options.runId } : {});
    await run.startAsync({ inputData: GmailNewMessageEventSchema.parse(event) });
    return { runId: run.runId };
  }

  /** Fire-and-forget start; returns the run id immediately. */
  async start(input: RestockTrigger, options: { resourceId?: string } = {}): Promise<StartedRun> {
    const inputData = RestockTriggerSchema.parse(input);
    const run = await this.workflow().createRun(options.resourceId ? { resourceId: options.resourceId } : {});
    await run.startAsync({ inputData });
    return { runId: run.runId };
  }

  /**
   * Resume a suspended run after a decision. Idempotent: does nothing unless the run is suspended
   * (a second click, a retried request or a resume that already happened are no-ops). Returns
   * whether a resume was dispatched. Does not wait for execution to finish.
   */
  async resumeAfterDecision(runId: string, data: RestockResume, workflowId: DecisionWorkflowId = RESTOCK_WORKFLOW_ID): Promise<boolean> {
    const workflow = this.decisionWorkflow(workflowId);
    const state = await workflow.getWorkflowRunById(runId, { fields: ['steps'] });
    if (!state || state.status !== 'suspended') return false;
    const run = await workflow.createRun({ runId });
    const params = { step: AWAIT_DECISION_STEP, resumeData: RestockResumeSchema.parse(data) };
    if ('resumeAsync' in run && typeof run.resumeAsync === 'function') {
      // Inngest: dispatch the resume event and return.
      await run.resumeAsync(params);
    } else {
      // Default engine: resume runs in-process; claim happens synchronously, the rest continues in the background.
      void run.resume(params).catch((err: unknown) => {
        this.mastra.getLogger()?.error(`${workflowId} resume failed`, { runId, error: err instanceof Error ? err.message : String(err) });
      });
    }
    return true;
  }
}

export const restockLauncher = new RestockLauncher();
