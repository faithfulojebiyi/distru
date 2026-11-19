// Ops Agent addition (no carbonme counterpart): what the proposal record page derives from one proposal, i.e. the
// system each op writes to, a human label per op, names for the ids its diff shows, and the items the agents flagged.
// Everything comes from fields the proposal already carries (opSummaries, op input/before, meta); no extra requests
// except the cached location list.
import { z } from 'zod';

import type { Icons } from '@ops/ui/icons/base';
import type {
  ProposalDetail,
  ProposalOp,
  ProposalOpSummary,
} from '../../api/generated/opsAgentAPI.schemas';
import { findRefs, resolveOpRef } from '../audit/audit-refs';
import { SYSTEM_LABELS, connectorName } from '../settings/settings-api';
import { actionLabel } from './proposal-values';

export type SystemGroup = { key: string; label: string; icon: keyof typeof Icons };

/** The system an op writes to, as the record page groups ops: ERP · Distru, Commerce · Distru MCP, Email, Tasks. */
export const systemOf = (action: string, summary: ProposalOpSummary | undefined): SystemGroup => {
  if (action.startsWith('distru.tasks')) return { key: 'tasks', label: 'Tasks', icon: 'task' };
  const connector = summary?.connector;
  if (!connector) {
    if (action.startsWith('email.')) return { key: 'email', label: 'Email', icon: 'sms' };
    return { key: action.split('.')[0] ?? 'other', label: actionLabel(action), icon: 'integrations' };
  }
  if (connector.id === 'distru') return { key: 'erp', label: 'ERP · Distru', icon: 'database' };
  if (connector.id === 'distru_mcp') return { key: 'commerce', label: 'Commerce · Distru MCP', icon: 'tag' };
  if (connector.id === 'email' || connector.system === 'email')
    return { key: 'email', label: connector.id === 'email' ? 'Email' : `Email · ${connectorName(connector.id)}`, icon: 'sms' };
  return {
    key: `${connector.system}:${connector.id}`,
    label: `${SYSTEM_LABELS[connector.system] ?? connector.system} · ${connectorName(connector.id)}`,
    icon: 'integrations',
  };
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const str = (value: unknown) => (typeof value === 'string' && value ? value : null);

/** "Email {{op:0.purchase_number}} …" with every placeholder that has a value filled in. */
export const resolveOpText = (text: string, ops: readonly ProposalOp[]) =>
  findRefs(text).reduce((out, ref) => {
    const resolution = resolveOpRef(ref, ops);
    return resolution ? out.replace(ref.token, String(resolution.value)) : out;
  }, text);

const vendorFromSummary = (summary: string | null | undefined) => (summary ? (/^PO to (.+?):/.exec(summary)?.[1] ?? null) : null);

/** "Purchase order → Coastal Cloud Vapes", "Buyer cap → Watermelon Gummies 100mg", from what the agent sent. */
export const opLabel = (op: ProposalOp, ops: readonly ProposalOp[]): string => {
  const input = record(op.input);
  const before = record(op.before);
  switch (op.action) {
    case 'distru.purchases.upsert': {
      const vendor = vendorFromSummary(op.summary) ?? str(input.vendor_name);
      const number = op.result?.outputs && str(record(op.result.outputs).purchase_number);
      return `Purchase order${number ? ` ${number}` : ''}${vendor ? ` → ${vendor}` : ''}`;
    }
    case 'email.send_vendor_po':
      return `Vendor email → ${str(input.vendor_name) ?? str(input.to) ?? 'vendor'}`;
    case 'distru.tasks.create':
      return `Task: ${resolveOpText(str(input.name) ?? 'receiving task', ops)}`;
    case 'distru_mcp.mutate_product':
      return `Buyer cap → ${str(before.name) ?? str(before.sku) ?? 'product'}`;
    case 'composio.gmail_reply_to_thread':
      return `Gmail reply${str(input.to) ? ` → ${str(input.to)}` : ''}`;
    default:
      return op.summary ? resolveOpText(op.summary, ops) : actionLabel(op.action);
  }
};

const AtRiskSchema = z.array(z.looseObject({ product_id: z.string().optional(), sku: z.string().optional(), vendor: z.string().optional(), location: z.string().optional() }));
const GuardSchema = z.array(
  z.looseObject({
    product_id: z.string().optional(),
    sku: z.string().optional(),
    name: z.string().optional(),
    cap: z.number().optional(),
    current_cap: z.number().nullable().optional(),
    reason: z.string().optional(),
  }),
);
const SuspiciousSchema = z.array(
  z.looseObject({ sku: z.string().optional(), note: z.string().optional(), source: z.string().optional(), excerpt: z.string().optional() }),
);
const LooseListSchema = z.array(z.unknown());

const parsed = <T>(schema: z.ZodType<T>, value: unknown, fallback: T): T => {
  const result = schema.safeParse(value);
  return result.success ? result.data : fallback;
};

/** Names for the ids a diff shows: products, vendors (companies) and locations. */
export const namesOf = (proposal: ProposalDetail, locations: readonly { id: string; name: string }[] = []) => {
  const names = new Map<string, string>();
  for (const location of locations) names.set(location.id, location.name);
  const meta = record(proposal.meta);
  for (const item of parsed(AtRiskSchema, meta.atRisk, [])) if (item.product_id && item.sku) names.set(item.product_id, item.sku);
  for (const item of parsed(GuardSchema, meta.allocationGuard, []))
    if (item.product_id && (item.name ?? item.sku)) names.set(item.product_id, item.name ?? item.sku ?? '');
  for (const op of proposal.ops) {
    const before = record(op.before);
    const id = str(before.id);
    if (id && (str(before.name) ?? str(before.sku))) names.set(id, str(before.name) ?? str(before.sku) ?? id);
    const input = record(op.input);
    const payload = record(op.payload);
    const vendor = vendorFromSummary(op.summary) ?? str(input.vendor_name);
    if (vendor) {
      const vendorId = str(input.vendor_id) ?? str(payload.company_id);
      if (vendorId) names.set(vendorId, vendor);
      if (str(payload.company_id)) names.set(str(payload.company_id) ?? '', vendor);
    }
    const recordId = op.result?.recordId;
    if (recordId && op.status === 'executed') names.set(recordId, opLabel(op, proposal.ops));
  }
  return names;
};

export type Flag = { kind: 'veto' | 'suspicious' | 'guard' | 'critique'; title: string; detail: string | null; excerpt?: string };

const textOf = (value: unknown): string | null => {
  if (typeof value === 'string') return value;
  const item = record(value);
  return str(item.reason) ?? str(item.message) ?? str(item.note) ?? str(item.detail) ?? null;
};

/** What the agents flagged on the way: compliance vetoes, suspicious untrusted text, buyer-cap guards, critiques. */
export const flagsOf = (proposal: ProposalDetail): Flag[] => {
  const meta = record(proposal.meta);
  const flags: Flag[] = [];
  for (const item of parsed(LooseListSchema, meta.vetoedLines, [])) {
    const row = record(item);
    flags.push({ kind: 'veto', title: `Compliance veto${str(row.sku) ? `: ${str(row.sku)}` : ''}`, detail: textOf(item) });
  }
  for (const item of parsed(SuspiciousSchema, meta.suspiciousText, []))
    flags.push({
      kind: 'suspicious',
      title: `Suspicious text${item.sku ? ` in ${item.sku}` : ''}${item.source ? ` (${item.source})` : ''}`,
      detail: item.note ?? null,
      ...(item.excerpt ? { excerpt: item.excerpt } : {}),
    });
  for (const item of parsed(GuardSchema, meta.allocationGuard, []))
    flags.push({
      kind: 'guard',
      title: `Buyer cap ${item.cap ?? '?'} on ${item.name ?? item.sku ?? 'a product'}${item.current_cap ? ` (was ${item.current_cap})` : ''}`,
      detail: item.reason ?? null,
    });
  for (const item of parsed(LooseListSchema, meta.critiques, [])) flags.push({ kind: 'critique', title: 'Reviewer critique', detail: textOf(item) });
  return flags;
};

/** The ops grouped by the system they write to, in first-seen order, with counts and value. */
export const groupsOf = (proposal: ProposalDetail) => {
  const summaries = new Map(proposal.opSummaries.map((summary) => [summary.index, summary]));
  const groups = new Map<string, SystemGroup & { ops: ProposalOp[]; value: number }>();
  for (const op of proposal.ops) {
    const system = systemOf(op.action, summaries.get(op.index));
    const group = groups.get(system.key) ?? { ...system, ops: [], value: 0 };
    group.ops.push(op);
    group.value += op.value ?? 0;
    groups.set(system.key, group);
  }
  return [...groups.values()];
};

/**
 * A short title and a one-paragraph summary. The server sends `summary` (with a short title) once it has the field;
 * until then a long title is split client-side at " for " or the first ": " so headers stay one line.
 */
export const titleParts = (proposal: { title: string | null; summary?: unknown }): { title: string; summary: string | null } => {
  const title = proposal.title ?? 'Untitled proposal';
  const summary = typeof proposal.summary === 'string' && proposal.summary ? proposal.summary : null;
  if (summary || title.length <= 60) return { title, summary };
  for (const separator of [' for ', ': ']) {
    const at = title.indexOf(separator);
    if (at >= 8 && at <= 60) {
      const rest = title.slice(at + separator.length);
      return { title: title.slice(0, at), summary: separator === ' for ' ? `For ${rest}` : `${rest.charAt(0).toUpperCase()}${rest.slice(1)}` };
    }
  }
  return { title: `${title.slice(0, 57).trimEnd()}…`, summary: title };
};

/** The breadcrumb's short title: at most ~40 characters. */
export const crumbTitle = (proposal: { title: string | null; summary?: unknown }) => {
  const { title } = titleParts(proposal);
  return title.length > 40 ? `${title.slice(0, 39).trimEnd()}…` : title;
};

/** The record icon by kind: restock → checklist, vendor reply → reply, undo → undo, Copilot / MCP / other → squarePen. */
export const proposalIcon = (proposal: Pick<ProposalDetail, 'undoOf' | 'title' | 'meta' | 'createdBy'>): 'checklist' | 'reply' | 'undo' | 'squarePen' => {
  if (proposal.undoOf) return 'undo';
  const workflow = str(record(proposal.meta).workflowId) ?? '';
  if (workflow.includes('reply') || /^vendor reply/i.test(proposal.title ?? '')) return 'reply';
  if (workflow === 'restock' || /^restock/i.test(proposal.title ?? '')) return 'checklist';
  return proposal.createdBy.kind === 'agent' ? 'checklist' : 'squarePen';
};
