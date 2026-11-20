/**
 * "Why the agent proposed this" for a restock proposal, composed in CODE from the agents' structured
 * outputs (no extra model call): per vendor what is at risk and why (days of supply vs lead time, retail
 * signal), how the Planner chose each quantity, what it knew about the vendor (synced profile, learned
 * memories) and what history it searched (recall citations), then the review: compliance vetoes, buyer-cap
 * guard, policy revisions. Markdown with one answer table, so the web renders it like a Copilot answer.
 *
 * The trigger (who started the run and their note) is NOT part of it: that is metadata, shown as a chip.
 * Also used by scripts/backfill-titles.ts to rewrite older proposals from what they stored.
 */

export interface RationaleVendor {
  id: string;
  name: string;
  lead_time_days: number | null;
}

/** The analysed facts for one SKU at one location (a subset of AtRiskSku; older proposals stored less). */
export interface RationaleRisk {
  product_id: string;
  sku: string | null;
  name?: string | null;
  vendor_id?: string | null;
  location_id?: string | null;
  location_name?: string | null;
  days_of_supply?: number | null;
  adjusted_days_of_supply?: number | null;
  reorder_status?: string | null;
  retail_signal?: string | null;
  retail_growth_3w_pct?: number | null;
  flagged_by?: string | null;
  reason?: string | null;
}

export interface RationalePlan {
  vendor_id: string;
  /** The Planner's latest summary for this vendor (after any revision). */
  summary: string | null;
  /** How each quantity was chosen (PlannedLine.reason), when the Planner reported lines. */
  lines: { product_id: string; location_id: string; decision: 'ordered' | 'skipped'; quantity: number; reason: string }[];
  /** The account-context block that was in the Planner's prompt (profile facts + learned memories). */
  context: string | null;
  /** History the Planner searched (recall_search): its query and the citations that came back. */
  recall: { query: string; refs: { ref: string; date: string | null }[] }[];
}

export interface RationaleOrderLine {
  vendor_id: string;
  location_id: string;
  product_id: string;
  quantity: number;
  unit_price: number;
}

export interface RationaleInput {
  vendors: readonly RationaleVendor[];
  atRisk: readonly RationaleRisk[];
  plans: readonly RationalePlan[];
  ordered: readonly RationaleOrderLine[];
  /** Location id → name (from the analysis, or Distru). */
  locations: ReadonlyMap<string, string>;
  /** Product id → SKU (fallback when the analysis did not carry it). */
  products?: ReadonlyMap<string, string>;
  vetoed: readonly { product_id: string; sku: string | null; location_id: string | null; reasons: readonly string[] }[];
  critiques: readonly { round: number; explanation: string }[];
  complianceSummary: string | null;
  /** Allocation-guard lines, already worded. */
  guard: readonly string[];
  /** Workflow notes (connector unavailable, vendor email skipped, …) and guard notes. */
  notes: readonly string[];
  handoffs: boolean;
  suspicious: readonly { sku: string | null; product_id: string | null; source: string }[];
  exhausted: { maxRevisions: number } | null;
  /** Older proposals: analyst summaries per location ("Oakland Warehouse: …"), used when no per-SKU facts exist. */
  analysisSummaries?: readonly string[];
}

const cell = (s: string) => s.replace(/\s+/g, ' ').replace(/\|/g, '/').trim();
/** Agent-written prose inside a list item: one line, no headings / tables / raw links. */
const prose = (s: string) => s.replace(/\s+/g, ' ').replace(/^#+\s*/, '').replace(/\|/g, '/').trim();
const days = (n: number | null | undefined) => (n === null || n === undefined ? null : `${Math.round(n * 10) / 10} d`);
const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const shortRef = (ref: string) => (ref.length > 48 ? `${ref.slice(0, 47)}…` : ref);

const RETAIL: Record<string, string> = { surging: 'surging', rising: 'rising', flat: 'flat', declining: 'declining', no_data: 'no retail data' };

function retailText(r: RationaleRisk | undefined): string {
  if (!r?.retail_signal) return '—';
  const pct = r.retail_growth_3w_pct;
  return `${RETAIL[r.retail_signal] ?? r.retail_signal}${pct !== null && pct !== undefined && r.retail_signal !== 'no_data' ? ` (${pct > 0 ? '+' : ''}${Math.round(pct)}% 3w)` : ''}`;
}

/** Vendor reliability and learned preferences from the context block (our own synced data, not ERP free text). */
function contextFacts(block: string | null, vendorId: string): { reliability: string | null; memories: string[] } {
  if (!block) return { reliability: null, memories: [] };
  const lines = block.split('\n');
  const vendorLine = lines.find((l) => l.includes(`[${vendorId}]`) && l.startsWith('Vendor '));
  const reliability = vendorLine ? (vendorLine.split(']: ')[1] ?? null)?.replace(/\.$/, '') ?? null : null;
  const memories = lines
    .filter((l) => l.startsWith('- ('))
    .map((l) => l.replace(/^- \([^)]*\)\s*/, '').replace(/\s*\[conf [^\]]*\]\s*$/, '').trim())
    .filter(Boolean)
    .slice(0, 3);
  return { reliability, memories };
}

export function composeRestockRationale(input: RationaleInput): string {
  const out: string[] = [];
  const vendorName = new Map(input.vendors.map((v) => [v.id, v.name]));
  const lead = new Map(input.vendors.map((v) => [v.id, v.lead_time_days]));
  const locName = (id: string | null | undefined) => (id ? (input.locations.get(id) ?? id) : 'all locations');
  const risk = (productId: string, locationId: string | null) =>
    input.atRisk.find((r) => r.product_id === productId && (r.location_id ?? null) === locationId) ?? input.atRisk.find((r) => r.product_id === productId && !r.location_id);
  const skuOf = (productId: string) => input.atRisk.find((r) => r.product_id === productId)?.sku ?? input.products?.get(productId) ?? productId.slice(0, 8);
  const planOf = new Map(input.plans.map((p) => [p.vendor_id, p]));

  // ── lead paragraph ────────────────────────────────────────────────────────────────────────────
  const vendorsOrdered = [...new Set(input.ordered.map((l) => l.vendor_id))];
  const locationsOrdered = [...new Set(input.ordered.map((l) => l.location_id))];
  const late = input.ordered.filter((l) => {
    const r = risk(l.product_id, l.location_id);
    const d = r?.adjusted_days_of_supply ?? r?.days_of_supply;
    const lt = lead.get(l.vendor_id);
    return d !== null && d !== undefined && lt !== null && lt !== undefined && d < lt;
  }).length;
  const facts = input.atRisk.length > 0;
  out.push(
    [
      facts
        ? `The Inventory Analysts flagged ${plural(input.atRisk.length, 'SKU')} at risk across ${plural(new Set(input.atRisk.map((r) => r.location_id ?? '*')).size, 'location')}.`
        : null,
      `The Procurement Planner ordered ${plural(input.ordered.length, 'line')} from ${plural(vendorsOrdered.length, 'vendor')} for ${plural(locationsOrdered.length, 'location')}${facts && late ? `; ${late} of them run out before the vendor's lead time would bring new stock` : ''}.`,
      input.vetoed.length ? `Compliance vetoed ${plural(new Set(input.vetoed.map((v) => v.product_id)).size, 'product')}.` : null,
      input.critiques.length ? `The plan was revised ${plural(input.critiques.length, 'time')} after policy feedback.` : null,
    ]
      .filter(Boolean)
      .join(' '),
  );

  // ── answer table: one row per ordered line (columns without any data are left out) ──────────────────
  if (input.ordered.length) {
    const rows = input.ordered.map((l) => {
      const r = risk(l.product_id, l.location_id);
      const d = r?.adjusted_days_of_supply ?? r?.days_of_supply;
      const lt = lead.get(l.vendor_id);
      return {
        Vendor: cell(vendorName.get(l.vendor_id) ?? l.vendor_id),
        SKU: cell(skuOf(l.product_id)),
        Location: cell(locName(l.location_id)),
        'Days of supply': d !== null && d !== undefined ? `${days(d)}${r?.reorder_status ? ` · ${cell(r.reorder_status)}` : ''}` : null,
        'Lead time': lt === null || lt === undefined ? null : `${lt} d`,
        Retail: r?.retail_signal ? cell(retailText(r)) : null,
        Ordered: `${l.quantity} @ ${usd(l.unit_price)}`,
      };
    });
    const columns = (Object.keys(rows[0]!) as (keyof (typeof rows)[number])[]).filter((c) => rows.some((row) => row[c] !== null));
    out.push('', `| ${columns.join(' | ')} |`, `|${columns.map(() => '---').join('|')}|`);
    for (const row of rows) out.push(`| ${columns.map((c) => row[c] ?? '—').join(' | ')} |`);
  }

  if (!facts && input.analysisSummaries?.length) {
    out.push('', '### Inventory analysis');
    for (const s of input.analysisSummaries) out.push(`- ${prose(s)}`);
  }

  // ── per vendor ───────────────────────────────────────────────────────────────────────────────────
  for (const vendorId of vendorsOrdered) {
    const name = vendorName.get(vendorId) ?? vendorId;
    const lt = lead.get(vendorId);
    const plan = planOf.get(vendorId);
    out.push('', `### ${name}${lt ? ` · ${lt}-day lead time` : ''}`);
    const lines = input.ordered.filter((l) => l.vendor_id === vendorId);
    for (const l of lines) {
      const r = risk(l.product_id, l.location_id);
      const d = r?.adjusted_days_of_supply ?? r?.days_of_supply;
      const why = r?.reason ? prose(r.reason) : null;
      const reason = plan?.lines.find((p) => p.product_id === l.product_id && p.location_id === l.location_id && p.decision === 'ordered')?.reason;
      const head = `**${cell(skuOf(l.product_id))}** at ${locName(l.location_id)}`;
      const supply = d !== null && d !== undefined ? `${Math.round(d * 10) / 10} days of supply${lt ? ` against a ${lt}-day lead time` : ''}` : null;
      const retail = r?.retail_signal && r.retail_signal !== 'no_data' ? `retail ${retailText(r)}` : null;
      const facts = [supply, retail].filter(Boolean).join(', ');
      out.push(
        `- ${head}: ${facts ? `${facts}. Ordered` : 'ordered'} ${l.quantity} at ${usd(l.unit_price)}${reason ? `: ${prose(reason)}` : '.'}${why && !reason ? ` Analyst: ${why}` : ''}`,
      );
    }
    for (const s of plan?.lines.filter((p) => p.decision === 'skipped') ?? []) out.push(`- Skipped ${cell(skuOf(s.product_id))} at ${locName(s.location_id)}: ${prose(s.reason)}`);
    const ctx = contextFacts(plan?.context ?? null, vendorId);
    if (ctx.reliability) out.push(`- Vendor record (synced history): ${prose(ctx.reliability)}.`);
    if (ctx.memories.length) out.push(`- Learned preferences the Planner had: ${ctx.memories.map((m) => `“${prose(m)}”`).join('; ')}.`);
    for (const r of plan?.recall ?? []) {
      out.push(
        `- Searched vendor history for “${prose(r.query)}”: ${r.refs.length ? r.refs.slice(0, 3).map((c) => `\`${shortRef(c.ref)}\`${c.date ? ` (${c.date.slice(0, 10)})` : ''}`).join(', ') : 'nothing relevant came back'}.`,
      );
    }
    if (plan?.summary) out.push(`- Planner's note: ${prose(plan.summary)}`);
  }

  // ── review ───────────────────────────────────────────────────────────────────────────────────────
  const review: string[] = [];
  if (input.vetoed.length) {
    const byProduct = new Map<string, { sku: string; locations: string[]; reason: string }>();
    for (const v of input.vetoed) {
      const prev = byProduct.get(v.product_id);
      const loc = locName(v.location_id);
      if (prev) {
        if (!prev.locations.includes(loc)) prev.locations.push(loc);
      } else byProduct.set(v.product_id, { sku: v.sku ?? skuOf(v.product_id), locations: [loc], reason: v.reasons[0] ?? 'blocked' });
    }
    review.push(`- Vetoed lines: ${[...byProduct.values()].map((v) => `**${cell(v.sku)}** at ${v.locations.join(', ')}: ${prose(v.reason)}`).join('; ')}`);
  }
  if (input.complianceSummary) review.push(`- Compliance review: ${prose(input.complianceSummary)}`);
  if (input.guard.length) review.push(`- Allocation guard (per-buyer menu caps, computed in code):\n${input.guard.map((g) => `  - ${prose(g)}`).join('\n')}`);
  if (input.handoffs)
    review.push('- Hand-offs: each PO is followed by its vendor email and a receiving task; both carry the PO number, filled in when the PO is written.');
  for (const n of input.notes) review.push(`- ${prose(n)}`);
  if (input.critiques.length) review.push(`- Policy revisions (Policy Critic):\n${input.critiques.map((c) => `  - Round ${c.round}: ${prose(c.explanation)}`).join('\n')}`);
  if (input.exhausted) review.push(`- Policy still denies after ${input.exhausted.maxRevisions} revisions; proposed for the record (it cannot be executed).`);
  if (input.suspicious.length)
    review.push(`- Ignored suspicious ERP text: ${input.suspicious.map((s) => `${cell(s.sku ?? s.product_id ?? '?')} (${cell(s.source)})`).join(', ')}. The agents did not follow it.`);
  if (review.length) out.push('', '### Review', ...review);

  return out.join('\n').trim();
}

/** Recall searches a Planner made, from its trace's tool calls (query + citations; never the passage text). */
export function recallFromToolCalls(toolCalls: readonly { tool: string; args?: unknown; result?: unknown }[]): RationalePlan['recall'] {
  const out: RationalePlan['recall'] = [];
  for (const call of toolCalls) {
    if (!/recall/i.test(call.tool)) continue;
    const args = (call.args ?? {}) as Record<string, unknown>;
    const query = typeof args.query === 'string' ? args.query : null;
    if (!query) continue;
    const result = (call.result ?? {}) as Record<string, unknown>;
    const passages = Array.isArray(result.passages) ? (result.passages as unknown[]) : [];
    const refs = passages
      .map((p) => (p && typeof p === 'object' ? (p as Record<string, unknown>) : {}))
      .filter((p) => typeof p.ref === 'string' && p.suspicious !== true)
      .map((p) => ({ ref: p.ref as string, date: typeof p.date === 'string' ? p.date : null }));
    out.push({ query, refs });
  }
  return out;
}
