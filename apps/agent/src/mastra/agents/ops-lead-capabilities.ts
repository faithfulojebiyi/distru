import { z } from 'zod';
import { AGENT_TOOLS } from './roster';

/**
 * What the Ops Lead can answer, by topic, each backed by the registry tools that answer it. The Copilot's new-chat
 * page shows this (GET /api/copilot/capabilities) so a demo user knows what to ask; topics whose tools aren't
 * available right now (e.g. recall off) drop out. A test checks every Ops Lead tool is covered by a topic and every
 * topic names only Ops Lead tools, so the list can't drift from the allowlist. Wording matches the root README's
 * "What you can ask it" table.
 */
export const CopilotTopicSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    source: z.string().describe('Where the answer comes from'),
    examples: z.array(z.string()).min(1).max(3),
    tools: z.array(z.string()).describe('Registry tools (or start_restock_run) that answer it'),
  })
  .meta({ id: 'CopilotTopic' });

export const CopilotCapabilitiesSchema = z
  .object({
    topics: z.array(CopilotTopicSchema),
    cannotDo: z.array(z.string()),
    dataset: z.string(),
  })
  .meta({ id: 'CopilotCapabilities' });
export type CopilotCapabilities = z.infer<typeof CopilotCapabilitiesSchema>;
type Topic = z.infer<typeof CopilotTopicSchema>;

/** The Ops Lead's own tool that is not a registry tool. */
export const START_RESTOCK_RUN = 'start_restock_run';

export const COPILOT_TOPICS: readonly Topic[] = [
  {
    id: 'stock',
    title: 'Stock at risk',
    source: "Distru's inventory-velocity report and stock levels, per warehouse",
    examples: ['Which SKUs will stock out before their next PO arrives?', "What's at risk at Oakland?"],
    tools: ['distru.velocity_report', 'distru.inventory'],
  },
  {
    id: 'retail',
    title: 'Retail demand',
    source: 'Headset sell-through trends and top movers',
    examples: ['What is retail sell-through telling us about Blue Dream?', "What's moving fastest at retail this week?"],
    tools: ['headset.retail_trends', 'headset.top_movers'],
  },
  {
    id: 'products',
    title: 'Products',
    source: 'Distru product catalogue',
    examples: ['Tell me about VAP-BD-1G', 'Which vapes do we carry from Coastal Cloud?'],
    tools: ['distru.products_get', 'distru.products_search'],
  },
  {
    id: 'vendors',
    title: 'Vendors',
    source: 'Vendor list, purchase history, and the reliability profiles the context layer computes',
    examples: ['Which vendor has the longest lead time?', 'How reliable is Sierra Extracts?'],
    tools: ['distru.vendors', 'distru.vendor_purchase_history', 'context.vendor_profile'],
  },
  {
    id: 'vendor-history',
    title: 'Vendor history',
    source: 'Search over past vendor emails and PO notes, with dates',
    examples: ['Has Sierra Extracts mentioned supply problems before?'],
    tools: ['recall.search'],
  },
  {
    id: 'compliance',
    title: 'Lab results and compliance',
    source: 'Distru lab results and Metrc package status',
    examples: ['Can we reorder Wedding Cake 3.5g?', 'Any products on hold?'],
    tools: ['distru.compliance_check'],
  },
  {
    id: 'orders',
    title: 'Open orders',
    source: 'Open sales orders in Distru',
    examples: ['What do customers have on order for Blue Dream?'],
    tools: ['distru.open_orders'],
  },
  {
    id: 'receivables',
    title: 'Money owed to us',
    source: 'Distru invoices and payments, with aging',
    examples: ['Which invoices are overdue? Sum by customer.', 'Who should we chase first?'],
    tools: ['distru.invoices_overdue', 'distru.invoices_search'],
  },
  {
    id: 'memories',
    title: 'What the team has learned',
    source: 'Memories learned from past approvals, with their evidence',
    examples: ['How does the approver usually treat Mojave orders?'],
    tools: ['context.memories_search'],
  },
  {
    id: 'restock',
    title: 'Getting work done',
    source: 'Starts a restock run; any changes still go to Approvals',
    examples: ['Start a restock run for Los Angeles.'],
    tools: [START_RESTOCK_RUN],
  },
];

export const COPILOT_CANNOT_DO: readonly string[] = [
  'Approve, reject or write anything itself. It can start a run or propose a change; a person approves.',
  "Answer from data it has no tool for: sales reps' performance, cultivation and harvests, manufacturing (assemblies), DistruCommerce menu settings, QuickBooks, payroll, or anything about other companies.",
  "Know about today's real world. All the data is the emulated distributor, Golden Coast Distribution.",
];

export const COPILOT_DATASET = 'Golden Coast Distribution (emulated): three warehouses, six vendors and six dispensaries.';

/** Every tool the Ops Lead may be given (its registry allowlist + start_restock_run). */
export const OPS_LEAD_TOOL_NAMES: readonly string[] = [...AGENT_TOOLS.opsLead, START_RESTOCK_RUN];

/**
 * The topics the Ops Lead can answer right now: those with at least one tool in `available` (the registry tool
 * names it currently has; start_restock_run is always there). Each topic lists only its available tools.
 */
export function copilotCapabilities(available: Iterable<string>): CopilotCapabilities {
  const have = new Set([...available, START_RESTOCK_RUN]);
  const topics = COPILOT_TOPICS.flatMap((topic) => {
    const tools = topic.tools.filter((tool) => have.has(tool));
    return tools.length ? [{ ...topic, examples: [...topic.examples], tools }] : [];
  });
  return { topics, cannotDo: [...COPILOT_CANNOT_DO], dataset: COPILOT_DATASET };
}
