import { Agent, type ToolsInput } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import { z } from 'zod';
import type { RestockLauncher } from '../restock-launcher';
import { AGENTS } from './roster';
import { UNTRUSTED_DATA_RULES, cachedInstructions, PROMPT_CACHE_OPTIONS } from './shared';
import type { MastraModelConfig } from '@mastra/core/llm';

export const OPS_LEAD_INSTRUCTIONS = `
You are the Ops Lead for a cannabis distributor running on Distru ERP. Operators ask you questions in a chat
(the Copilot). You understand the request, delegate to specialists, and write a short, accurate answer.
You have read-only access: you cannot propose, approve or execute anything.

## Your specialists (delegate with their agent tools)
- inventory-analyst: velocity, stock and open orders for a location → ranked at-risk SKUs.
- procurement-planner: vendors, purchase history, quantities and prices. Outside a restock run it can create a
  pending proposal for human approval; only ask it to when the operator explicitly asks for a PO draft.
- compliance-reviewer: lab results and Metrc packages; approves or vetoes products.
- policy-critic: explains why the policy engine denied a draft.
Pass each specialist the ids and numbers it needs (location ids, vendor ids, product ids) in your prompt.
For simple lookups, use your own read tools instead of delegating.

## Restock runs
When the operator asks to restock (or to "run the restock", "reorder what's low"), call start_restock_run.
It starts the durable restock workflow (parallel analysts → planners → compliance and policy review → one
proposal that waits for a human approver). Tell the operator the run id and that the proposal will appear in
Approvals. Never claim a PO was created: only an approved proposal executes, and deterministic code does it.

## Answers
Be concise. Lead with the answer, then the evidence (SKUs, numbers, dates). Say when data is missing.

${UNTRUSTED_DATA_RULES}`.trim();

export function createStartRestockRunTool(launcher: RestockLauncher) {
  return createTool({
    id: 'start_restock_run',
    description:
      'Start the durable restock workflow (analysts → planners → compliance + policy review → one proposal awaiting human approval). Returns the run id. Optional scope: location, vendor or product ids.',
    inputSchema: z.object({
      scenarioNote: z.string().max(1000).optional().describe("The operator's request, verbatim or summarised"),
      locationIds: z.array(z.string().min(1)).max(20).optional(),
      vendorIds: z.array(z.string().min(1)).max(50).optional(),
      productIds: z.array(z.string().min(1)).max(100).optional(),
    }),
    execute: async (input, context) => {
      const user = context?.requestContext?.get('userId');
      const triggeredBy = typeof user === 'string' && user ? `agent:ops-lead (user ${user})` : 'agent:ops-lead';
      const { runId } = await launcher.start({ triggeredBy, ...input }, typeof user === 'string' && user ? { resourceId: user } : {});
      return { runId, status: 'started', next: 'The proposal will appear in Approvals when the run suspends for a decision.' };
    },
  });
}

export interface OpsLeadOptions<TTools extends ToolsInput, TAgents extends Record<string, Agent>> {
  model: MastraModelConfig;
  /** Read tools (harness-generated for the read-only principal) + start_restock_run; static or resolved per call. */
  tools: TTools | (() => TTools);
  /** The specialists, exposed to the Ops Lead as subagents (Mastra supervisor pattern). */
  agents: TAgents;
  memory?: Memory;
}

/**
 * Supervisor. Mastra's supported mechanism: specialists go in the `agents` property; the model
 * delegates through generated agent tools, and each subagent runs with its own instructions,
 * tools, model and memory isolation. Memory: one thread per user (resource = user id, which the
 * auth provider maps; Copilot passes `memory: { resource: userId, thread: 'ops-lead-' + userId }`).
 */
export function createOpsLead<TTools extends ToolsInput, TAgents extends Record<string, Agent>>(options: OpsLeadOptions<TTools, TAgents>) {
  return new Agent({
    id: AGENTS.opsLead.id,
    name: AGENTS.opsLead.name,
    description: 'Supervisor for Distru operations: answers Copilot questions by delegating to inventory, procurement, compliance and policy specialists; can start a restock run. Read-only.',
    instructions: cachedInstructions(OPS_LEAD_INSTRUCTIONS),
    model: options.model,
    tools: options.tools,
    agents: options.agents,
    memory: options.memory ?? new Memory({ options: { lastMessages: 20 } }),
    // Copilot turns cache too (system + tools, and the growing conversation).
    defaultOptions: { maxSteps: 12, ...PROMPT_CACHE_OPTIONS },
  });
}
