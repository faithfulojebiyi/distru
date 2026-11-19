/**
 * The context layer as a harness connector (`context`, system `analytics`): read tools only, so
 * every agent can ask "what do we know?" through the same registry, scopes and audit as everything
 * else. Registered names: `context.vendor_profile` → agent tool `context_vendor_profile`, etc.
 */
import { defineConnector, defineReadTool, type ConnectorContext } from '@ops/harness';
import { z } from 'zod';
import { effectiveConfidence, isLive } from './memory';
import type { MemoryScope } from './model';
import { MemoryScopeSchema } from './model';
import { contextFor } from './retrieval';
import type { ContextStore } from './store';
import { runUnifiedQuery, UnifiedQuerySchema } from './unified';
import { safeLabel, systemClock, type ContextClock } from './util';

export interface ContextService {
  store: ContextStore;
  clock?: ContextClock;
}

export type ContextCtx = ConnectorContext<'context', ContextService>;

/** Convenience: `{ connectors: { context: { store, clock } } }`. */
export function createContextContext(service: ContextService): ContextCtx {
  return { connectors: { context: service } };
}

const svc = (ctx: ContextCtx) => ctx.connectors.context;
const nowOf = (ctx: ContextCtx) => (svc(ctx).clock ?? systemClock).now();

async function memoriesFor(ctx: ContextCtx, scope: MemoryScope, scopeId: string, limit = 5) {
  const now = nowOf(ctx);
  return (await svc(ctx).store.listMemories({ scope, scopeIds: [scopeId], statuses: ['active'] }))
    .filter((m) => isLive(m, now))
    .map((m) => ({ id: m.id, key: m.key, statement: m.statement, confidence: effectiveConfidence(m, now), evidence_count: m.evidenceCount, origin: m.origin }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);
}

const vendorProfile = defineReadTool({
  name: 'vendor_profile',
  description:
    'Account profile of one vendor from synced data: promised vs actual lead time (median order→receipt), on-time %, fill rate, price trends per product (last vs 90-day avg), plus learned memories about how approvers treat this vendor. Give vendor_id or a name fragment.',
  input: z
    .object({ vendor_id: z.string().optional(), name: z.string().min(2).optional() })
    .refine((v) => v.vendor_id || v.name, { message: 'vendor_id or name is required' }),
  run: async (ctx: ContextCtx, input) => {
    const profile = await svc(ctx).store.latestProfile();
    if (!profile) return { found: false, reason: 'No profile computed yet' };
    const v = profile.vendors.find((x) => (input.vendor_id ? x.vendorId === input.vendor_id : x.name.toLowerCase().includes(input.name!.toLowerCase())));
    if (!v) return { found: false, reason: 'Vendor not in profile' };
    return { found: true, profile_version: profile.version, computed_at: profile.computedAt, vendor: { ...v, name: safeLabel(v.name) }, memories: await memoriesFor(ctx, 'vendor', v.vendorId) };
  },
});

const productProfile = defineReadTool({
  name: 'product_profile',
  description:
    'Account profile of one product: demand per day (last 28d vs prior 28d) and trend, weekday seasonality hint, available stock and days of supply, retail sell-through signal (Headset) when available, plus learned memories. Give product_id or sku.',
  input: z
    .object({ product_id: z.string().optional(), sku: z.string().optional() })
    .refine((v) => v.product_id || v.sku, { message: 'product_id or sku is required' }),
  run: async (ctx: ContextCtx, input) => {
    const profile = await svc(ctx).store.latestProfile();
    if (!profile) return { found: false, reason: 'No profile computed yet' };
    const p = profile.products.find((x) => (input.product_id ? x.productId === input.product_id : x.sku?.toLowerCase() === input.sku!.toLowerCase()));
    if (!p) return { found: false, reason: 'Product not in profile' };
    return { found: true, profile_version: profile.version, computed_at: profile.computedAt, product: { ...p, name: safeLabel(p.name) }, memories: await memoriesFor(ctx, 'product', p.productId) };
  },
});

const memoriesSearch = defineReadTool({
  name: 'memories_search',
  description:
    'Search live memories (learned from approvals, approver edits, rejections, compliance vetoes and policy changes, or told by users). Filter by scope/scope_id and/or keywords; results carry confidence and evidence counts.',
  input: z.object({
    query: z.string().max(200).optional(),
    scope: MemoryScopeSchema.optional(),
    scope_id: z.string().optional(),
    limit: z.number().int().positive().max(50).default(10),
  }),
  run: async (ctx: ContextCtx, input) => {
    const now = nowOf(ctx);
    const terms = (input.query ?? '').toLowerCase().split(/\s+/).filter((t) => t.length > 1);
    const all = await svc(ctx).store.listMemories({ ...(input.scope ? { scope: input.scope } : {}), ...(input.scope_id ? { scopeIds: [input.scope_id] } : {}), statuses: ['active'] });
    const rows = all
      .filter((m) => isLive(m, now))
      .map((m) => {
        const hay = `${m.statement} ${m.key}`.toLowerCase();
        const score = terms.length ? terms.filter((t) => hay.includes(t)).length : 1;
        return { m, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || effectiveConfidence(b.m, now) - effectiveConfidence(a.m, now))
      .slice(0, input.limit)
      .map(({ m }) => ({
        id: m.id,
        scope: m.scope,
        scope_id: m.scopeId,
        key: m.key,
        statement: m.statement,
        confidence: effectiveConfidence(m, now),
        evidence_count: m.evidenceCount,
        evidence: { proposal_ids: m.evidence.proposalIds.slice(0, 10), audit_ids: m.evidence.auditIds.slice(0, 10) },
        origin: m.origin,
        last_confirmed_at: m.lastConfirmedAt,
      }));
    return { count: rows.length, memories: rows };
  },
});

const contextForTool = defineReadTool({
  name: 'context_for',
  description:
    'Compact, size-bounded context block for the vendors/products/customers you are working on: profile facts (lead times, fill rate, price and demand trends, stock, retail signal) and the top memories with evidence counts. Call before drafting a proposal.',
  input: z.object({
    vendor_ids: z.array(z.string()).max(20).optional(),
    product_ids: z.array(z.string()).max(50).optional(),
    customer_ids: z.array(z.string()).max(20).optional(),
    limit: z.number().int().positive().max(20).default(8),
    max_chars: z.number().int().min(500).max(8000).default(4000),
  }),
  run: async (ctx: ContextCtx, input) => {
    const block = await contextFor(
      svc(ctx).store,
      {
        ...(input.vendor_ids ? { vendorIds: input.vendor_ids } : {}),
        ...(input.product_ids ? { productIds: input.product_ids } : {}),
        ...(input.customer_ids ? { customerIds: input.customer_ids } : {}),
        limit: input.limit,
        maxChars: input.max_chars,
      },
      { clock: svc(ctx).clock ?? systemClock },
    );
    return { text: block.text, profile_version: block.profileVersion, computed_at: block.computedAt, memory_ids: block.memories.map((m) => m.id), truncated: block.truncated };
  },
});

const unifiedQuery = defineReadTool({
  name: 'unified_query',
  description:
    'Read-only query over the unified data layer (Distru sync + other connectors). Pick a predefined shape: stock_by_product_location, purchases_by_vendor, sales_by_product_week, sales_by_customer, facts. Parameters are typed; there is no SQL. Rows are capped.',
  input: z.object({ query: UnifiedQuerySchema }),
  run: async (ctx: ContextCtx, input) => runUnifiedQuery(svc(ctx).store, input.query, { clock: svc(ctx).clock ?? systemClock }),
});

export const contextConnector = defineConnector<ContextCtx>({
  id: 'context',
  system: 'analytics',
  description: 'Context layer: account profile, learned memories and a read-only unified query over synced data.',
  readTools: [vendorProfile, productProfile, memoriesSearch, contextForTool, unifiedQuery],
  actions: [],
  health: async (ctx) => {
    const profile = await svc(ctx).store.latestProfile();
    const cursors = await svc(ctx).store.listCursors();
    return { ok: !!profile, detail: profile ? `profile v${profile.version} @ ${profile.computedAt}; ${cursors.length} sync cursors` : 'no profile yet' };
  },
});
