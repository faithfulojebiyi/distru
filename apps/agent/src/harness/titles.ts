/**
 * Proposal headlines: a short `title` (≤ 60 chars, human: "Cover Blue Dream stock-outs before Dec 3")
 * and a `summary` (one or two sentences, ≤ 300 chars). Agents (Procurement Planner, Vendor Liaison) write
 * them; CODE decides whether they may be used:
 *
 * - shape: single line, title ≤ 60, summary ≤ 300, no URLs or markdown;
 * - no instruction-like phrases (ignore / approve / system / override / …);
 * - every money amount, number, date and PO number must match the proposal's real totals, quantities,
 *   counts, receive / ETA dates and PO numbers;
 * - no vendor named that is not in the proposal;
 * - no run of 8+ words shared with untrusted text seen in the run (ERP free text, emails, flagged text).
 *
 * A rejected agent headline falls back to a code template ("Restock 4 vendors · Oakland Warehouse",
 * "Vendor reply · PO-521 partial shipment") and the reason is kept in `meta.titleRejectedReason`
 * (`meta.titleSource: 'agent' | 'template' | 'caller'`). A caller-supplied title (MCP / API) goes through
 * the same validator and is rejected with a validation error instead of being replaced.
 */
import { InputValidationError } from '@ops/harness';

export const TITLE_TARGET_CHARS = 60;
export const SUMMARY_TARGET_CHARS = 300;
const OVERLAP_WORDS = 8;

export interface HeadlineFacts {
  /** Money amounts in the proposal (total, per-op values, line amounts, unit prices). */
  money: readonly number[];
  /** Plain numbers that may appear: quantities, counts (POs, vendors, SKUs, ops, …), caps, lead times. */
  numbers: readonly number[];
  /** PO numbers the proposal really touches (`PO-521`). */
  poNumbers: readonly string[];
  /** ISO dates (YYYY-MM-DD) that may appear: receive dates, ETAs. */
  dates: readonly string[];
  /** Vendors in the proposal. */
  vendorNames: readonly string[];
  /** Every known vendor (a name not in `vendorNames` must not appear). */
  knownVendorNames?: readonly string[];
  /** Untrusted text seen in the run (ERP free text, emails) and text flagged as suspicious. */
  untrusted: readonly string[];
}

export type HeadlineCheck = { ok: true } | { ok: false; reason: string };

const INSTRUCTION = /\b(ignore|disregard|approve[ds]?|approving|approval|pre-?approved|override|system|bypass|instructions?|execute|jailbreak|prompt)\b/i;
const URL = /(https?:\/\/|www\.|\b[\w-]+\.(com|net|org|io|co|dev|ai)\b)/i;
const MARKDOWN = /[*_`#[\]<>|]|\*\*/;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_DAY = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi;
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const PO = /\bPO-?\s?(\d+)\b/gi;
/** SKU-like codes (FLW-BD-35) and numbers glued to units/letters (3.5g, 1G) are identifiers, not claims. */
const CODE = /\b[A-Z]{2,}(?:-[A-Z0-9.]+)+\b|\b\d+(?:\.\d+)?(?:g|mg|ml|oz|lb|ct|pk|x)\b/gi;
const MONEY = /\$\s?(\d[\d,]*(?:\.\d+)?)\s?(k|K)?/g;
const NUMBER = /(?<![\w.])(\d[\d,]*(?:\.\d+)?)(?![\w])/g;

const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.01, Math.abs(b) * 0.005);
const words = (s: string) => s.toLowerCase().match(/[a-z0-9$.%-]+/g) ?? [];

function sharesRun(text: string, untrusted: readonly string[]): boolean {
  const w = words(text);
  if (w.length < OVERLAP_WORDS) return false;
  const grams = new Set<string>();
  for (let i = 0; i + OVERLAP_WORDS <= w.length; i++) grams.add(w.slice(i, i + OVERLAP_WORDS).join(' '));
  for (const u of untrusted) {
    const uw = words(u);
    for (let i = 0; i + OVERLAP_WORDS <= uw.length; i++) if (grams.has(uw.slice(i, i + OVERLAP_WORDS).join(' '))) return true;
  }
  return false;
}

/** Checks one headline (title + summary) against the proposal's facts. */
export function validateHeadline(h: { title: string; summary?: string | null }, facts: HeadlineFacts): HeadlineCheck {
  const title = h.title;
  const summary = h.summary ?? '';
  if (!title.trim()) return { ok: false, reason: 'empty title' };
  if (/[\r\n]/.test(title) || /[\r\n]/.test(summary)) return { ok: false, reason: 'title and summary must be single lines' };
  if (title.length > TITLE_TARGET_CHARS) return { ok: false, reason: `title is ${title.length} characters (max ${TITLE_TARGET_CHARS})` };
  if (summary.length > SUMMARY_TARGET_CHARS) return { ok: false, reason: `summary is ${summary.length} characters (max ${SUMMARY_TARGET_CHARS})` };
  const text = `${title} ${summary}`;
  if (URL.test(text)) return { ok: false, reason: 'contains a URL' };
  if (MARKDOWN.test(text)) return { ok: false, reason: 'contains markdown' };
  const instruction = text.match(INSTRUCTION);
  if (instruction) return { ok: false, reason: `instruction-like phrase "${instruction[0]}"` };
  if (sharesRun(text, facts.untrusted)) return { ok: false, reason: `shares ${OVERLAP_WORDS}+ words with untrusted text seen in the run` };

  for (const name of facts.knownVendorNames ?? []) {
    if (facts.vendorNames.some((v) => v.toLowerCase() === name.toLowerCase())) continue;
    if (name.length >= 4 && text.toLowerCase().includes(name.toLowerCase())) return { ok: false, reason: `names vendor "${name}", which is not in the proposal` };
  }

  let rest = text;
  const allowedDays = facts.dates.map((d) => ({ m: Number(d.slice(5, 7)), d: Number(d.slice(8, 10)) }));
  for (const m of text.matchAll(MONTH_DAY)) {
    const month = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()) + 1;
    const day = Number(m[2]);
    if (!allowedDays.some((a) => a.m === month && a.d === day)) return { ok: false, reason: `date "${m[0]}" is not a receive date or ETA of the proposal` };
    rest = rest.replace(m[0], ' ');
  }
  for (const m of text.matchAll(ISO_DATE)) {
    if (!facts.dates.includes(m[0])) return { ok: false, reason: `date ${m[0]} is not a receive date or ETA of the proposal` };
    rest = rest.replace(m[0], ' ');
  }
  for (const m of text.matchAll(PO)) {
    if (!facts.poNumbers.some((p) => p.replace(/\D/g, '') === m[1])) return { ok: false, reason: `PO number "${m[0]}" is not in the proposal` };
    rest = rest.replace(m[0], ' ');
  }
  rest = rest.replace(CODE, ' ');
  for (const m of rest.matchAll(MONEY)) {
    const value = Number(m[1]!.replace(/,/g, '')) * (m[2] ? 1000 : 1);
    const ok = facts.money.some((v) => (m[2] ? Math.abs(v - value) <= Math.max(50, v * 0.01) : near(value, v)));
    if (!ok) return { ok: false, reason: `amount "${m[0].trim()}" does not match the proposal` };
    rest = rest.replace(m[0], ' ');
  }
  for (const m of rest.matchAll(NUMBER)) {
    const value = Number(m[1]!.replace(/,/g, ''));
    if (!facts.numbers.some((v) => near(value, v)) && !facts.money.some((v) => near(value, v))) return { ok: false, reason: `number ${m[1]} does not match the proposal` };
  }
  return { ok: true };
}

export interface ChosenHeadline {
  title: string;
  summary: string | null;
  meta: { titleSource: 'agent' | 'template'; titleRejectedReason?: string };
}

/** The agent's headline when it passes the validator, else the code template (with the reason). */
export function chooseHeadline(agent: { title?: string | null; summary?: string | null } | null, template: { title: string; summary: string | null }, facts: HeadlineFacts): ChosenHeadline {
  if (!agent?.title) return { ...template, meta: { titleSource: 'template', titleRejectedReason: agent ? 'the agent wrote no title' : 'no single agent headline for this proposal' } };
  const check = validateHeadline({ title: agent.title, summary: agent.summary ?? null }, facts);
  if (!check.ok) return { ...template, meta: { titleSource: 'template', titleRejectedReason: check.reason } };
  return { title: agent.title.trim(), summary: agent.summary?.trim() || template.summary, meta: { titleSource: 'agent' } };
}

/** Joins a template from parts, shortening the variable part (never the prefix) to fit 60 characters. */
export function fitTitle(prefix: string, variable: string): string {
  const room = TITLE_TARGET_CHARS - prefix.length;
  return prefix + (variable.length <= room ? variable : `${variable.slice(0, Math.max(1, room - 1)).trimEnd()}…`);
}

export const restockTemplateTitle = (args: { vendors: readonly string[]; skuCount: number; locations: readonly string[] }): string =>
  args.vendors.length === 1
    ? fitTitle(`Restock ${args.skuCount} SKU${args.skuCount === 1 ? '' : 's'} · `, args.vendors[0]!)
    : fitTitle(`Restock ${args.vendors.length} vendors · `, args.locations.length === 1 ? args.locations[0]! : `${args.locations.length} locations`);

const KIND_LABEL: Record<string, string> = { partial: 'partial shipment', delay: 'delay', confirm: 'confirmation', price_change: 'price change', other: 'update' };
export const vendorReplyTemplateTitle = (poNumber: string, kind: string): string => fitTitle('Vendor reply · ', `${poNumber} ${KIND_LABEL[kind] ?? kind}`);

/** Every `untrusted_text` string inside a value (tool results in the run trace, email threads). */
export function untrustedTextsIn(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 12 || value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const v of value) untrustedTextsIn(v, out, depth + 1);
    return out;
  }
  const rec = value as Record<string, unknown>;
  if (typeof rec.untrusted_text === 'string') out.push(rec.untrusted_text);
  for (const v of Object.values(rec)) untrustedTextsIn(v, out, depth + 1);
  return out;
}

/**
 * Facts for a caller-supplied headline (MCP / Copilot propose): every number, ISO date and PO number
 * found in the ops' input, planned payload and current record, plus the op values. Generic on purpose:
 * a caller may only mention what the proposal itself contains.
 */
export function factsFromOps(ops: ReadonlyArray<{ input?: unknown; payload?: unknown; before?: unknown; value?: number | null }>, extra: Partial<HeadlineFacts> = {}): HeadlineFacts {
  const numbers: number[] = [];
  const dates: string[] = [];
  const poNumbers: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 10 || v === null || v === undefined) return;
    if (typeof v === 'number' && Number.isFinite(v)) numbers.push(v);
    else if (typeof v === 'string') {
      for (const m of v.matchAll(ISO_DATE)) dates.push(m[0]);
      for (const m of v.matchAll(PO)) poNumbers.push(`PO-${m[1]}`);
      if (/^\d+(\.\d+)?$/.test(v)) numbers.push(Number(v));
    } else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1);
  };
  for (const op of ops) {
    walk(op.input, 0);
    walk(op.payload, 0);
    walk(op.before, 0);
  }
  const values = ops.map((o) => o.value).filter((v): v is number => typeof v === 'number');
  const total = values.reduce((a, b) => a + b, 0);
  return {
    money: [...values, total, ...numbers, ...(extra.money ?? [])],
    numbers: [...numbers, ops.length, ...(extra.numbers ?? [])],
    poNumbers: [...poNumbers, ...(extra.poNumbers ?? [])],
    dates: [...dates, ...(extra.dates ?? [])],
    vendorNames: extra.vendorNames ?? [],
    ...(extra.knownVendorNames ? { knownVendorNames: extra.knownVendorNames } : {}),
    untrusted: extra.untrusted ?? [],
  };
}

/**
 * Headline for a single-op proposal made outside a workflow (Copilot propose tool, MCP propose tools):
 * a caller-supplied title/summary must pass the validator (InputValidationError otherwise, never
 * replaced or truncated); without one, a template from the op's own summary.
 */
export function callerHeadline(
  preview: { summary: string | null; value: number | null; input: unknown; payload: unknown; diff?: unknown },
  caller: { title?: string | undefined; summary?: string | undefined },
  fallback: string,
): { title: string; summary: string | null; meta: { titleSource: 'caller' | 'template' } } {
  if (caller.title !== undefined || caller.summary !== undefined) {
    if (!caller.title) throw new InputValidationError('summary needs a title');
    const check = validateHeadline({ title: caller.title, summary: caller.summary ?? null }, factsFromOps([{ input: preview.input, payload: preview.payload, before: preview.diff, value: preview.value }]));
    if (!check.ok) throw new InputValidationError(`title/summary rejected: ${check.reason}`);
    return { title: caller.title.trim(), summary: caller.summary?.trim() ?? preview.summary, meta: { titleSource: 'caller' } };
  }
  const text = preview.summary ?? fallback;
  return { title: fitTitle('', text.replace(/\s+/g, ' ')), summary: text.length > TITLE_TARGET_CHARS ? text : null, meta: { titleSource: 'template' } };
}
