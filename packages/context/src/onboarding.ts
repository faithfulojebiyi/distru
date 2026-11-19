/**
 * Agentic onboarding, deterministic part: after the first sync, report data completeness, vendors
 * missing promised lead times, and suggested starting policy rules with the evidence behind each.
 * An onboarding agent turns this into a conversation; the numbers come from here, not from the LLM.
 * Suggested rules use the harness's built-in rule keys and parameter shapes.
 */
import type { PolicyRuleConfig } from '@ops/harness';
import { buildProfile } from './profile';
import type { ProfileSnapshot } from './model';
import type { ContextStore } from './store';
import { DISTRU_SOURCE } from './sync/normalize';
import { DAY_MS, iso, percentile, round, safeLabel, systemClock, type ContextClock } from './util';

export interface PolicySuggestion {
  rule: PolicyRuleConfig;
  rationale: string;
  evidence: Record<string, unknown>;
}

export interface OnboardingReport {
  generatedAt: string;
  completeness: {
    score: number;
    products: { total: number; active: number; withSku: number; withVendor: number; withCost: number };
    companies: { vendors: number; customers: number; other: number };
    purchases: { total: number; completed: number; withOrderDate: number; withReceipt: number; from: string | null; to: string | null };
    orders: { total: number; withLines: number; from: string | null; to: string | null; historyDays: number };
    inventory: { snapshotAt: string | null; rows: number };
    issues: string[];
  };
  vendorsMissingLeadTimes: { vendorId: string; name: string; observedMedianDays: number | null; samples: number; suggestion: string }[];
  suggestedPolicy: PolicySuggestion[];
}

/** Round a cap up to a "nice" number (2 significant digits). */
export function niceCeil(n: number): number {
  if (n <= 0) return 0;
  const mag = 10 ** Math.max(0, Math.floor(Math.log10(n)) - 1);
  return Math.ceil(n / mag) * mag;
}

export function niceFloor(n: number): number {
  if (n <= 0) return 0;
  const mag = 10 ** Math.max(0, Math.floor(Math.log10(n)) - 1);
  return Math.floor(n / mag) * mag;
}

export async function onboardingReport(store: ContextStore, opts: { clock?: ContextClock; source?: string; profile?: ProfileSnapshot } = {}): Promise<OnboardingReport> {
  const clock = opts.clock ?? systemClock;
  const now = clock.now();
  const nowMs = now.getTime();
  const source = opts.source ?? DISTRU_SOURCE;
  const [products, companies, purchases, orders, inventory] = await Promise.all([
    store.list('product', { source }),
    store.list('company', { source }),
    store.list('purchase', { source }),
    store.list('order', { source }),
    store.latestInventory(source),
  ]);
  const profile = opts.profile ?? (await store.latestProfile()) ?? (await buildProfile(store, { clock, source }));

  const placed = purchases.filter((p) => p.status !== 'DRAFT');
  const orderDates = orders.map((o) => o.orderedAt).filter((d): d is string => !!d).sort();
  const poDates = placed.map((p) => p.orderedAt).filter((d): d is string => !!d).sort();
  const historyDays = orderDates.length ? Math.round((Date.parse(orderDates.at(-1)!) - Date.parse(orderDates[0]!)) / DAY_MS) : 0;
  const vendors = companies.filter((c) => c.relationship === 'vendor');

  const issues: string[] = [];
  const checks: [boolean, string][] = [
    [products.length > 0, 'No products synced'],
    [products.every((p) => !!p.sku), `${products.filter((p) => !p.sku).length} products have no SKU (retail data cannot be joined)`],
    [products.every((p) => !!p.vendorId), `${products.filter((p) => !p.vendorId).length} products have no vendor`],
    [products.every((p) => p.unitCost !== null), `${products.filter((p) => p.unitCost === null).length} products have no unit cost`],
    [placed.length >= 5, `Only ${placed.length} purchase orders; policy suggestions are weak`],
    [historyDays >= 56, `Only ${historyDays} days of sales history; demand trends need 8+ weeks`],
    [inventory !== null, 'No inventory snapshot yet'],
    [vendors.every((v) => v.promisedLeadTimeDays !== null), `${vendors.filter((v) => v.promisedLeadTimeDays === null).length} vendors have no promised lead time`],
  ];
  for (const [ok, msg] of checks) if (!ok) issues.push(msg);
  const score = round(checks.filter(([ok]) => ok).length / checks.length, 2);

  const vendorsMissingLeadTimes = profile.vendors
    .filter((v) => v.promisedLeadTimeDays === null)
    .map((v) => ({
      vendorId: v.vendorId,
      name: safeLabel(v.name),
      observedMedianDays: v.actualLeadTimeDays,
      samples: v.leadTimeSamples,
      suggestion:
        v.actualLeadTimeDays !== null
          ? `Record a promised lead time; observed median order→receipt is ${v.actualLeadTimeDays} days over ${v.leadTimeSamples} POs`
          : 'Record a promised lead time; no completed POs to observe one from',
    }));

  // ── policy suggestions ─────────────────────────────────────────────────────────────────────
  const suggestedPolicy: PolicySuggestion[] = [];
  const totals = placed.map((p) => ({ id: p.sourceId, number: p.number, total: p.total })).filter((p): p is { id: string; number: string | null; total: number } => p.total !== null && p.total > 0);
  const values = totals.map((t) => t.total);
  if (values.length) {
    const p50 = percentile(values, 50)!;
    const p95 = percentile(values, 95)!;
    const p25 = percentile(values, 25)!;
    const max = Math.max(...values);
    const cap = niceCeil(p95);
    const above = totals.filter((t) => t.total > cap).sort((a, b) => b.total - a.total);
    suggestedPolicy.push({
      rule: { key: 'max_total_value', params: { max: cap, currency: 'USD' }, enabled: true },
      rationale: `Deny proposals above the 95th percentile of historical PO totals (p95 ${round(p95, 2)}, rounded up to ${cap}); ${above.length} of ${values.length} past POs would have been above it.`,
      evidence: { metric: 'p95 of purchase totals', sample: values.length, p25: round(p25, 2), p50: round(p50, 2), p95: round(p95, 2), max: round(max, 2), abovePurchaseIds: above.slice(0, 5).map((a) => a.id), abovePurchaseNumbers: above.slice(0, 5).map((a) => a.number) },
    });
    const amount = Math.max(1, niceFloor(p25));
    const below = totals.filter((t) => t.total < amount);
    suggestedPolicy.push({
      rule: { key: 'auto_approve_below', params: { amount, max_risk: 'low' }, enabled: true },
      rationale: `Auto-approve low-risk proposals below the 25th percentile of PO totals (p25 ${round(p25, 2)}, rounded down to ${amount}); ${below.length} of ${values.length} past POs fall below it. Medium/high-risk ops still need a human.`,
      evidence: { metric: 'p25 of purchase totals', sample: values.length, p25: round(p25, 2), belowCount: below.length, belowPurchaseIds: below.slice(0, 5).map((b) => b.id) },
    });
  }
  const cutoff = nowMs - 180 * DAY_MS;
  const recentByVendor = new Map<string, string>();
  for (const p of placed) {
    if (!p.vendorId || !p.orderedAt || Date.parse(p.orderedAt) < cutoff) continue;
    if ((recentByVendor.get(p.vendorId) ?? '') < p.orderedAt) recentByVendor.set(p.vendorId, p.orderedAt);
  }
  if (recentByVendor.size) {
    const names = new Map(companies.map((c) => [c.sourceId, safeLabel(c.name)]));
    const allowed = [...recentByVendor.keys()].sort((a, b) => (names.get(a) ?? a).localeCompare(names.get(b) ?? b));
    const excluded = vendors.filter((v) => !recentByVendor.has(v.sourceId));
    suggestedPolicy.push({
      rule: { key: 'vendor_allowlist', params: { vendorIds: allowed, onViolation: 'needs_approval' }, enabled: true },
      rationale: `Allow vendors with a purchase order in the last 180 days (${allowed.length}); proposals to any other vendor need a human.`,
      evidence: {
        window: `${iso(cutoff).slice(0, 10)}..${iso(nowMs).slice(0, 10)}`,
        vendors: allowed.map((id) => ({ id, name: names.get(id) ?? id, lastPurchaseAt: recentByVendor.get(id) })),
        excluded: excluded.map((v) => ({ id: v.sourceId, name: safeLabel(v.name) })),
      },
    });
  }
  suggestedPolicy.push({
    rule: { key: 'high_risk_requires_approval', params: {}, enabled: true },
    rationale: 'Always route high-risk ops (writes that reach Metrc, QuickBooks or other external systems) to a human.',
    evidence: { default: true },
  });

  return {
    generatedAt: iso(now),
    completeness: {
      score,
      products: {
        total: products.length,
        active: products.filter((p) => p.isActive).length,
        withSku: products.filter((p) => !!p.sku).length,
        withVendor: products.filter((p) => !!p.vendorId).length,
        withCost: products.filter((p) => p.unitCost !== null).length,
      },
      companies: { vendors: vendors.length, customers: companies.filter((c) => c.relationship === 'customer').length, other: companies.filter((c) => c.relationship === 'other').length },
      purchases: {
        total: purchases.length,
        completed: purchases.filter((p) => p.status === 'COMPLETED').length,
        withOrderDate: purchases.filter((p) => !!p.orderedAt).length,
        withReceipt: purchases.filter((p) => !!p.receivedAt).length,
        from: poDates[0] ?? null,
        to: poDates.at(-1) ?? null,
      },
      orders: { total: orders.length, withLines: orders.filter((o) => o.lines.length > 0).length, from: orderDates[0] ?? null, to: orderDates.at(-1) ?? null, historyDays },
      inventory: { snapshotAt: inventory?.snapshotAt ?? null, rows: inventory?.rows.length ?? 0 },
      issues,
    },
    vendorsMissingLeadTimes,
    suggestedPolicy,
  };
}
