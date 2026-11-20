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

/** Location ids → names, as the record page knows them (cached location list, plus what the proposal names). */
export type NameMap = ReadonlyMap<string, string>;

const OP_REF = /\{\{op:(\d+)\.[A-Za-z0-9_]+\}\}/;

/** The op an email / task hands off from: the PO its `{{op:N.purchase_number}}` placeholder points at. */
const referencedOp = (op: ProposalOp, ops: readonly ProposalOp[]) => {
  const input = record(op.input);
  for (const value of [input.po_number, input.purchase_id, input.name]) {
    const match = typeof value === 'string' ? OP_REF.exec(value) : null;
    if (match) return ops.find((item) => item.index === Number(match[1]));
  }
  return undefined;
};

/** The PO number once the PO is written (from its result), else null. */
const poNumberOf = (op: ProposalOp | undefined) => (op?.result?.outputs ? str(record(op.result.outputs).purchase_number) : null);

/** The location a PO delivers to, by name when known. */
const poLocationOf = (op: ProposalOp | undefined, names: NameMap) => {
  if (!op) return null;
  const id = str(record(op.input).location_id) ?? str(record(z.array(z.unknown()).catch([]).parse(record(op.payload).items)[0]).location_id);
  return id ? (names.get(id) ?? null) : null;
};

const SHORT_DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
/** "2026-12-03" → "Dec 3". */
const shortDate = (iso: string | null) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? SHORT_DATE.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`)) : null);

/**
 * A label per op that tells same-vendor rows apart: "Purchase order PO-524 → Golden State Edibles · Oakland
 * Warehouse", "Vendor email → Golden State Edibles · PO-524" (the PO's location until it has a number),
 * "Receive PO-524 · Dec 3", "Buyer cap → Watermelon Gummies 100mg".
 */
export const opLabel = (op: ProposalOp, ops: readonly ProposalOp[], names: NameMap = new Map()): string => {
  const input = record(op.input);
  const before = record(op.before);
  const join = (...parts: (string | null)[]) => parts.filter(Boolean).join(' · ');
  switch (op.action) {
    case 'distru.purchases.upsert': {
      const vendor = vendorFromSummary(op.summary) ?? str(input.vendor_name);
      const number = poNumberOf(op);
      return join(`Purchase order${number ? ` ${number}` : ''}${vendor ? ` → ${vendor}` : ''}`, poLocationOf(op, names));
    }
    case 'email.send_vendor_po': {
      const po = referencedOp(op, ops);
      const vendor = str(input.vendor_name) ?? str(input.to) ?? 'vendor';
      return join(`Vendor email → ${vendor}`, poNumberOf(po) ?? poLocationOf(po, names));
    }
    case 'distru.tasks.create': {
      const po = referencedOp(op, ops);
      const due = shortDate(str(input.due));
      const number = poNumberOf(po);
      if (number) return join(`Receive ${number}`, due);
      const vendor = po ? (vendorFromSummary(po.summary) ?? str(record(po.input).vendor_name)) : null;
      if (po || vendor) return join(`Receive ${vendor ?? 'the'} PO`, poLocationOf(po, names), due);
      return `Task: ${resolveOpText(str(input.name) ?? 'receiving task', ops)}`;
    }
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
    if (recordId && op.status === 'executed') names.set(recordId, opLabel(op, proposal.ops, names));
  }
  return names;
};

export type Flag = {
  kind: 'veto' | 'suspicious' | 'guard' | 'critique';
  title: string;
  detail: string | null;
  excerpt?: string;
  /** Where / when it applied: locations, review rounds. */
  chips?: string[];
  /** The full reasons, shown when the row is expanded. */
  more?: string[];
};

const textOf = (value: unknown): string | null => {
  if (typeof value === 'string') return value.trim() || null;
  const item = record(value);
  return (str(item.explanation) ?? str(item.reason) ?? str(item.message) ?? str(item.note) ?? str(item.detail))?.trim() || null;
};

const VetoSchema = z.array(
  z.looseObject({
    product_id: z.string().optional(),
    sku: z.string().nullish(),
    location_id: z.string().nullish(),
    reasons: z.array(z.string()).catch([]).optional(),
    round: z.number().nullish(),
  }),
);
const CritiqueSchema = z.array(z.looseObject({ round: z.number().optional(), explanation: z.string().optional() }));

/** Words in a reason, for telling near-identical reasons apart (the Reviewer and the deterministic check say it twice). */
const reasonKey = (reason: string) => reason.toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim();

/**
 * What the agents flagged on the way: compliance vetoes (one row per product and reason, its locations and rounds as
 * chips), suspicious untrusted text, buyer-cap guards and the Policy Critic's critiques (with their round). Rows with
 * no text are left out.
 */
export const flagsOf = (proposal: ProposalDetail, names: NameMap = new Map()): Flag[] => {
  const meta = record(proposal.meta);
  const flags: Flag[] = [];
  const vetoes = new Map<string, { sku: string; reasons: string[]; locations: string[]; rounds: number[] }>();
  for (const item of parsed(VetoSchema, meta.vetoedLines, [])) {
    const reasons = [...new Map((item.reasons ?? []).map((reason) => [reasonKey(reason), reason.trim()])).values()].filter(Boolean);
    const sku = item.sku ?? item.product_id ?? 'a product';
    const key = `${item.product_id ?? sku}|${reasons[0] ? reasonKey(reasons[0]) : ''}`;
    const entry = vetoes.get(key) ?? { sku, reasons, locations: [], rounds: [] };
    const location = item.location_id ? (names.get(item.location_id) ?? null) : null;
    if (location && !entry.locations.includes(location)) entry.locations.push(location);
    if (typeof item.round === 'number' && !entry.rounds.includes(item.round)) entry.rounds.push(item.round);
    for (const reason of reasons) if (!entry.reasons.some((known) => reasonKey(known) === reasonKey(reason))) entry.reasons.push(reason);
    vetoes.set(key, entry);
  }
  for (const veto of vetoes.values())
    flags.push({
      kind: 'veto',
      title: `Compliance veto: ${veto.sku}`,
      detail: veto.reasons[0] ?? null,
      chips: [...veto.locations, ...veto.rounds.sort((a, b) => a - b).map((round) => `Round ${round}`)],
      more: veto.reasons.slice(1),
    });
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
  const critiques = parsed(CritiqueSchema, meta.critiques, []);
  const seen = new Set<string>();
  for (const [index, item] of critiques.entries()) {
    const text = textOf(item);
    if (!text || seen.has(reasonKey(text))) continue;
    seen.add(reasonKey(text));
    const round = item.round ?? index + 1;
    flags.push({ kind: 'critique', title: 'Policy Critic', detail: text, chips: [`Round ${round}`] });
  }
  return flags.filter((flag) => flag.kind !== 'critique' || Boolean(flag.detail));
};

const TriggerSchema = z.looseObject({ triggeredBy: z.string().optional(), scenarioNote: z.string().nullish(), source: z.string().optional(), fromAddress: z.string().nullish() });

/**
 * Who or what started the run behind a proposal, for the meta chips: "Manual · operator@demo.dev", the note as
 * "restock anything at risk before the weekend". Plain text only (never a link).
 */
export const triggerOfProposal = (proposal: Pick<ProposalDetail, 'meta'>): { label: string; note: string | null } | null => {
  const trigger = TriggerSchema.safeParse(record(proposal.meta).trigger);
  if (!trigger.success) return null;
  const by = trigger.data.triggeredBy ?? null;
  const note = trigger.data.scenarioNote?.replace(/^\s*[A-Z][a-z]+:\s+/, '').replace(/[.\s]+$/, '') || null;
  if (by) {
    const [kind, who] = by.includes(':') ? [by.slice(0, by.indexOf(':')), by.slice(by.indexOf(':') + 1)] : ['user', by];
    const label = kind === 'cron' ? 'Schedule' : kind === 'webhook' ? 'Webhook' : kind === 'agent' ? 'Copilot' : 'Manual';
    return { label: who && kind !== 'cron' ? `${label} · ${who}` : label, note };
  }
  if (trigger.data.source) return { label: `${trigger.data.source === 'composio' ? 'Vendor email' : trigger.data.source}${trigger.data.fromAddress ? ` · ${trigger.data.fromAddress}` : ''}`, note };
  return null;
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
