import { z } from 'zod';

/**
 * The eval scenario format. A scenario is data: which seeded world to boot (Distru mock scenario,
 * Headset scenario, policy overrides, mock faults), what to trigger (a restock run, a Copilot
 * question, a vendor reply), the scope, and a list of typed assertions over what the run produced.
 * Write the scenario (and its assertions) before you trust a prompt change.
 */

export const DISTRU_MOCK_SCENARIOS = ['default', 'clean', 'failed-lab-test', 'prompt-injection', 'no-reorder-needed'] as const;
export const HEADSET_MOCK_SCENARIOS = ['default', 'clean', 'failed-lab-test', 'prompt-injection', 'no-reorder-needed', 'no-retail-signal'] as const;

const Pattern = z.string().min(1).describe('Case-insensitive regular expression');

// ── assertions ──────────────────────────────────────────────────────────────────────────────────

export const AssertionSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('proposal_contains_sku'), sku: z.string() }),
    z.object({ kind: z.literal('proposal_excludes_sku'), sku: z.string() }),
    z.object({ kind: z.literal('vetoed_sku_with_reason'), sku: z.string(), reason: Pattern }),
    z.object({ kind: z.literal('max_total_value'), usd: z.number().nonnegative() }),
    z.object({
      kind: z.literal('policy_outcome'),
      outcome: z.enum(['allow', 'needs_approval', 'deny']).optional(),
      proposalStatus: z.string().optional().describe('e.g. pending_approval, auto_approved, executed'),
      runStatus: z.string().optional().describe('restock result status (executed, nothing_to_order, …) or run state (suspended, success, failed)'),
    }),
    z.object({ kind: z.literal('revision_rounds_at_least'), rounds: z.number().int().nonnegative(), max: z.number().int().nonnegative().optional() }),
    z.object({
      kind: z.literal('op_count_by_action'),
      action: z.string(),
      count: z.number().int().nonnegative().optional(),
      min: z.number().int().nonnegative().optional(),
      max: z.number().int().nonnegative().optional(),
    }),
    z.object({ kind: z.literal('no_op_with_quantity_above'), quantity: z.number().nonnegative(), sku: z.string().optional() }),
    z.object({ kind: z.literal('injection_flagged'), sku: z.string() }),
    z.object({
      kind: z.literal('at_risk_flagged'),
      sku: z.string(),
      flaggedBy: z.enum(['wholesale', 'retail', 'both']).optional(),
      recommendation: z.enum(['reorder_now', 'watch', 'ok']).optional(),
    }),
    z.object({ kind: z.literal('injection_not_obeyed'), sku: z.string(), quantity: z.number().positive().default(5000) }),
    z.object({ kind: z.literal('idempotent_reexecute') }),
    z.object({ kind: z.literal('verify_all_ok') }),
    z.object({ kind: z.literal('audit_event'), type: z.string(), min: z.number().int().positive().default(1) }),
    z.object({ kind: z.literal('writes'), resource: z.enum(['purchases', 'tasks']), count: z.number().int().nonnegative() }),
    z.object({ kind: z.literal('cost_below_usd'), usd: z.number().positive() }),
    z.object({ kind: z.literal('tokens_below'), tokens: z.number().int().positive() }),
    z.object({ kind: z.literal('latency_below_ms'), ms: z.number().int().positive() }),
    z.object({ kind: z.literal('answer_mentions'), patterns: z.array(Pattern).min(1), mode: z.enum(['all', 'any']).default('all') }),
    z.object({ kind: z.literal('answer_avoids'), patterns: z.array(Pattern).min(1) }),
    z.object({ kind: z.literal('tool_called'), tool: Pattern }),
    z.object({ kind: z.literal('tool_not_called'), tool: Pattern }),
    z.object({ kind: z.literal('handoff_occurred'), agent: z.string().describe('Agent id, e.g. compliance-reviewer') }),
    z.object({
      kind: z.literal('llm_judge'),
      criteria: z.array(z.string().min(1)).min(1).describe('Rubric; every criterion must hold'),
    }),
  ])
  .meta({ id: 'EvalAssertion' });
export type Assertion = z.infer<typeof AssertionSchema>;
export type AssertionKind = Assertion['kind'];

// ── trigger + setup ─────────────────────────────────────────────────────────────────────────────

export const TriggerSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('restock'),
      note: z.string().optional(),
      /** After the run suspends: approve the proposal and let the executor run. */
      approve: z.boolean().default(false),
      /** After execution: call harness.execute again (a replayed step) and count writes. */
      reexecute: z.boolean().default(false),
    }),
    z.object({ kind: z.literal('copilot'), question: z.string().min(1) }),
    z.object({ kind: z.literal('vendor_reply'), from: z.string(), subject: z.string(), body: z.string() }),
  ])
  .meta({ id: 'EvalTrigger' });
export type Trigger = z.infer<typeof TriggerSchema>;

export const PolicyRuleOverrideSchema = z.object({ key: z.string(), params: z.record(z.string(), z.unknown()), enabled: z.boolean().optional() });

export const EmulatorSetupSchema = z
  .object({
    /** Replace (by key) or add policy rules on top of the seeded defaults. */
    policyRules: z.array(PolicyRuleOverrideSchema).default([]),
    /** `POST /__mock/config` bodies for the Distru mock, applied at a phase of the run. */
    distruMockConfig: z.array(z.object({ phase: z.enum(['before_run', 'before_execute']), body: z.record(z.string(), z.unknown()) })).default([]),
  })
  .meta({ id: 'EvalEmulatorSetup' });
export type EmulatorSetup = z.infer<typeof EmulatorSetupSchema>;

export const ScenarioSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    title: z.string().min(1),
    description: z.string().min(1).describe('The customer-style use case this protects, and why it matters'),
    /** Ready scenarios run; pending ones are reported (with the reason) and never fail the suite. */
    status: z.enum(['ready', 'pending']).default('ready'),
    pendingReason: z.string().optional(),
    tags: z.array(z.string()).default([]),
    /**
     * Recording to replay (default: the scenario id). Scenarios whose LLM conversation is identical
     * (same mock world and scope; they differ only after the agents are done, e.g. approve + faults
     * at execution) share one recording, so they cost one recording pass.
     */
    recording: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
    mockScenario: z.enum(DISTRU_MOCK_SCENARIOS),
    headsetScenario: z.enum(HEADSET_MOCK_SCENARIOS).optional(),
    emulatorSetup: EmulatorSetupSchema.default({ policyRules: [], distruMockConfig: [] }),
    trigger: TriggerSchema,
    scope: z
      .object({
        /** Location name prefixes, e.g. "Los Angeles". Keep to one location to keep recordings cheap. */
        locations: z.array(z.string()).default([]),
        /** Restrict the run to these SKUs (resolved to product ids). */
        skus: z.array(z.string()).optional(),
      })
      .default({ locations: [] }),
    expectations: z.array(AssertionSchema).min(1),
  })
  .superRefine((s, ctx) => {
    if (s.status === 'pending' && !s.pendingReason) ctx.addIssue({ code: 'custom', message: 'pending scenarios need a pendingReason', path: ['pendingReason'] });
    const copilotOnly: AssertionKind[] = ['answer_mentions', 'answer_avoids', 'llm_judge'];
    if (s.trigger.kind === 'restock') {
      for (const [i, a] of s.expectations.entries()) {
        if (copilotOnly.includes(a.kind)) ctx.addIssue({ code: 'custom', message: `${a.kind} needs a copilot trigger`, path: ['expectations', i] });
      }
      const needsExecution = s.expectations.some((a) => a.kind === 'idempotent_reexecute' || a.kind === 'verify_all_ok');
      if (needsExecution && !s.trigger.approve) ctx.addIssue({ code: 'custom', message: 'execution assertions need trigger.approve', path: ['trigger', 'approve'] });
      if (s.expectations.some((a) => a.kind === 'idempotent_reexecute') && !s.trigger.reexecute) {
        ctx.addIssue({ code: 'custom', message: 'idempotent_reexecute needs trigger.reexecute', path: ['trigger', 'reexecute'] });
      }
    }
  })
  .meta({ id: 'EvalScenario' });
export type Scenario = z.infer<typeof ScenarioSchema>;
export type ScenarioInput = z.input<typeof ScenarioSchema>;

export function defineScenario(input: ScenarioInput): Scenario {
  return ScenarioSchema.parse(input);
}
