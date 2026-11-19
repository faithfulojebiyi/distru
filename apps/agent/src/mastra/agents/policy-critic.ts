import { Agent } from '@mastra/core/agent';
import type { ToolsInput } from '@mastra/core/agent';
import { z } from 'zod';
import { AGENTS } from './roster';
import { UNTRUSTED_DATA_RULES, type AgentFactoryOptions, cachedInstructions } from './shared';

export const RevisionInstructionSchema = z
  .object({
    vendor_id: z.string(),
    instruction: z.string().max(800).describe('Concrete, numeric instruction for the Planner, e.g. "Reduce FLW-BD-35 to 48 units so the PO is at most $1,200"'),
  })
  .meta({ id: 'RevisionInstruction' });

export const PolicyCritiqueSchema = z
  .object({
    explanation: z.string().max(1500).describe('Which rules failed and why, in plain language for the approver'),
    revisions: z.array(RevisionInstructionSchema).describe('One entry per vendor whose draft must change'),
    summary: z.string().max(600),
  })
  .meta({ id: 'PolicyCritique' });
export type PolicyCritique = z.infer<typeof PolicyCritiqueSchema>;

export const POLICY_CRITIC_INSTRUCTIONS = `
You are the Policy Critic. A deterministic policy engine (code, not an LLM) evaluated the draft purchase
orders and denied them. You explain the failures and tell the Procurement Planner exactly how to revise.
You never override, reinterpret or weaken a rule, and you never suggest getting around one (no splitting a
PO to dodge a cap, no switching vendors to dodge an allowlist unless the rule itself requires it).

## Method
1. Read every reason with outcome "deny" (and "needs_approval" for context). Rules include max_total_value
   (total cap), allowed_actions, vendor_allowlist, auto_approve_below, high_risk_requires_approval, and
   plan_guard (deterministic sanity checks, e.g. a quantity far above the analysed suggestion).
2. For each vendor whose draft must change, write ONE concrete instruction with numbers: which SKU, which
   quantity, which target total. To fit a total cap, cut the least urgent lines first and keep the most
   urgent SKUs (lowest days of supply). Distribute the cap across vendors proportionally to urgency when
   several vendors are involved.
3. For plan_guard quantity findings, instruct the Planner to go back to the analysed suggested quantity.
4. If a rule cannot be satisfied by any revision (e.g. an action that is never allowed), say so in
   \`explanation\` and return no revision for that vendor.

${UNTRUSTED_DATA_RULES}`.trim();

export interface CritiqueTask {
  evaluation: unknown;
  ops: Array<{ vendor_id: string | null; summary: string | null; value: number | null; input: unknown }>;
  atRisk: Array<{ product_id: string; sku: string; vendor_id: string; days_of_supply: number | null; suggested_qty: number | null }>;
  round: number;
}

export function policyCriticPrompt(task: CritiqueTask): string {
  return [
    `Review round ${task.round}. The policy engine denied the draft.`,
    `Policy evaluation: ${JSON.stringify(task.evaluation)}`,
    `Draft POs: ${JSON.stringify(task.ops)}`,
    `At-risk SKUs (urgency data): ${JSON.stringify(task.atRisk)}`,
    'Explain the failures and give concrete revision instructions per vendor.',
  ].join('\n');
}

export function createPolicyCritic<TTools extends ToolsInput>({ model, tools }: AgentFactoryOptions<TTools>) {
  return new Agent({
    id: AGENTS.policyCritic.id,
    name: AGENTS.policyCritic.name,
    description:
      'Explains why the deterministic policy engine denied a draft and returns concrete, numeric revision instructions for the Procurement Planner. Never weakens a rule. Read-only.',
    instructions: cachedInstructions(POLICY_CRITIC_INSTRUCTIONS),
    model,
    tools,
  });
}
