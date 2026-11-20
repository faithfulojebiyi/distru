import { z } from 'zod';
import { composeRestockRationale, type RationalePlan, type RationaleRisk } from '../mastra/workflows/restock-rationale';
import { restockSummary, restockTemplateTitle, summaryRepeatsTitle } from '../harness/titles';

/**
 * Rewrites a restock proposal stored before summaries and rationales were composed in code: a summary that
 * repeats the title ("Restock: 14 POs ($22,999.57) for …") becomes one human sentence, a bare template title
 * ("Restock 6 vendors") gains its place, and a rationale that opens with "Triggered by …" is recomposed from
 * what the proposal stored (its ops, meta and the old rationale's per-vendor Planner summaries). Pure; used by
 * scripts/backfill-titles.ts. Returns only the fields that change (null when nothing does).
 */

export interface StoredOp {
  opIndex: number;
  action: string;
  input: unknown;
  summary: string | null;
  value: number | null;
}

export interface StoredProposal {
  title: string | null;
  summary: string | null;
  rationale: string | null;
  meta: Record<string, unknown>;
}

export interface Lookups {
  locations: ReadonlyMap<string, string>;
  products: ReadonlyMap<string, string>;
  vendors: ReadonlyMap<string, { name: string; lead_time_days: number | null }>;
}

const PurchaseInput = z.object({
  vendor_id: z.string(),
  location_id: z.string(),
  notes: z.string().nullish(),
  lines: z.array(z.object({ product_id: z.string(), quantity: z.number(), unit_price: z.number() })),
});

const VetoSchema = z.array(
  z.looseObject({ product_id: z.string(), sku: z.string().nullable().default(null), location_id: z.string().nullable().default(null), reasons: z.array(z.string()).default([]) }),
);
const CritiqueSchema = z.array(z.looseObject({ round: z.number(), explanation: z.string() }));
const SuspiciousSchema = z.array(z.looseObject({ sku: z.string().nullable().default(null), product_id: z.string().nullable().default(null), source: z.string() }));
const AtRiskSchema = z.array(
  z.looseObject({
    product_id: z.string(),
    sku: z.string().nullable().default(null),
    location: z.string().nullable().default(null),
    days_of_supply: z.number().nullable().default(null),
    adjusted_days_of_supply: z.number().nullable().default(null),
    reorder_status: z.string().nullable().default(null),
    retail_signal: z.string().nullable().default(null),
    retail_growth_3w_pct: z.number().nullable().default(null),
    flagged_by: z.string().nullable().default(null),
  }),
);

const parse = <T>(schema: z.ZodType<T>, value: unknown, fallback: T): T => {
  const r = schema.safeParse(value);
  return r.success ? r.data : fallback;
};

/** The old rationale's sections: "## Heading" → its lines. Lines before the first heading go under "". */
function sections(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>([['', []]]);
  let current = '';
  for (const line of text.split('\n')) {
    const h = /^##\s+(.*)$/.exec(line);
    if (h) {
      current = h[1]!.trim();
      out.set(current, out.get(current) ?? []);
      continue;
    }
    if (line.trim()) out.get(current)!.push(line);
  }
  return out;
}

export function rewriteRestockProposal(p: StoredProposal, ops: readonly StoredOp[], lookups: Lookups): Partial<Pick<StoredProposal, 'title' | 'summary' | 'rationale'>> | null {
  const workflow = typeof p.meta.workflowId === 'string' ? p.meta.workflowId : null;
  if (workflow !== 'restock') return null;
  const pos = ops
    .filter((o) => o.action === 'distru.purchases.upsert')
    .map((o) => ({ op: o, input: PurchaseInput.safeParse(o.input) }))
    .filter((x): x is { op: StoredOp; input: { success: true; data: z.infer<typeof PurchaseInput> } } => x.input.success)
    .map((x) => ({ op: x.op, input: x.input.data }));
  if (!pos.length) return null;

  const vendorFromSummary = (s: string | null) => (s ? (/^PO to (.+?):/.exec(s)?.[1] ?? null) : null);
  const vendorName = (id: string, op?: StoredOp) => lookups.vendors.get(id)?.name ?? vendorFromSummary(op?.summary ?? null) ?? id;
  const vendorIds = [...new Set(pos.map((x) => x.input.vendor_id))];
  const vendorNames = vendorIds.map((id) => vendorName(id, pos.find((x) => x.input.vendor_id === id)?.op));
  const locationIds = [...new Set(pos.map((x) => x.input.location_id))];
  const locationNames = locationIds.map((id) => lookups.locations.get(id) ?? id);
  const count = (action: string) => ops.filter((o) => o.action === action).length;
  const total = pos.every((x) => x.op.value !== null) ? Math.round(pos.reduce((s, x) => s + (x.op.value ?? 0), 0) * 100) / 100 : null;
  const out: Partial<Pick<StoredProposal, 'title' | 'summary' | 'rationale'>> = {};

  if (p.meta.titleSource !== 'agent' && p.title && /^Restock \d+ vendors$/.test(p.title)) {
    out.title = restockTemplateTitle({ vendors: vendorNames, skuCount: new Set(pos.flatMap((x) => x.input.lines.map((l) => l.product_id))).size, locations: locationNames });
  }
  // Also the old code template ("5 POs ($15,795.32) for A, B + 2 vendor emails.").
  if (summaryRepeatsTitle(out.title ?? p.title, p.summary) || /^\d+ POs? \(/.test(p.summary ?? '')) {
    out.summary = restockSummary({
      poCount: pos.length,
      total,
      vendors: vendorNames,
      locations: locationNames,
      caps: count('distru_mcp.mutate_product'),
      emails: count('email.send_vendor_po'),
      tasks: count('distru.tasks.create'),
    });
  }

  if (p.rationale && /^Triggered by /.test(p.rationale)) {
    const old = sections(p.rationale);
    const plan = old.get('Purchase plan') ?? [];
    const latestSummary = (name: string) => {
      const line = [...plan].reverse().find((l) => l.startsWith(`${name}: `));
      return line ? line.slice(name.length + 2).replace(/^Revision \d+:\s*/, '') : null;
    };
    const guardSection = [...old.entries()].find(([k]) => k.startsWith('Allocation guard'))?.[1] ?? [];
    const loose = [...(old.get('Hand-offs') ?? []), ...(old.get('') ?? [])].filter((l) => /unavailable|no purchase-order email|skipped/i.test(l));
    const atRisk = parse(AtRiskSchema, p.meta.atRisk, []);
    const locationIdByName = new Map([...lookups.locations].map(([id, name]) => [name, id]));
    const risks: RationaleRisk[] = atRisk.map((a) => ({
      ...a,
      location_id: a.location ? (locationIdByName.get(a.location) ?? null) : null,
      location_name: a.location,
    }));
    const plans: RationalePlan[] = vendorIds.map((id) => ({
      vendor_id: id,
      summary: latestSummary(vendorName(id)),
      // The Planner's note on each PO is how it chose the quantities there (shown once, on the PO's first line).
      lines: pos
        .filter((x) => x.input.vendor_id === id && x.input.notes)
        .flatMap((x) => x.input.lines.slice(0, 1).map((l) => ({ product_id: l.product_id, location_id: x.input.location_id, decision: 'ordered' as const, quantity: l.quantity, reason: x.input.notes! }))),
      context: null,
      recall: [],
    }));
    out.rationale = composeRestockRationale({
      vendors: vendorIds.map((id) => ({ id, name: vendorName(id), lead_time_days: lookups.vendors.get(id)?.lead_time_days ?? null })),
      atRisk: risks,
      plans,
      ordered: pos.flatMap((x) => x.input.lines.map((l) => ({ vendor_id: x.input.vendor_id, location_id: x.input.location_id, product_id: l.product_id, quantity: l.quantity, unit_price: l.unit_price }))),
      locations: lookups.locations,
      products: lookups.products,
      vetoed: parse(VetoSchema, p.meta.vetoedLines, []),
      critiques: parse(CritiqueSchema, p.meta.critiques, []),
      complianceSummary: (old.get('Compliance') ?? []).filter((l) => !l.startsWith('Vetoed lines:')).join(' ') || null,
      guard: guardSection.map((l) => l.replace(/^-\s*/, '')),
      notes: loose,
      handoffs: old.has('Hand-offs'),
      suspicious: parse(SuspiciousSchema, p.meta.suspiciousText, []),
      exhausted: p.meta.reviewOutcome === 'exhausted' ? { maxRevisions: typeof p.meta.revisions === 'number' ? p.meta.revisions : 2 } : null,
      analysisSummaries: old.get('Inventory analysis') ?? [],
    });
  }
  return Object.keys(out).length ? out : null;
}
