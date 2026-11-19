/**
 * Memories learned from the harness: durable, explainable statements derived by deterministic
 * rules from approvals, rejections, approver edits, policy denials, compliance vetoes and policy
 * rule revisions. Every memory carries its evidence (proposal ids + audit/signal ids), counts, a
 * confidence, and decays when it stops being confirmed.
 *
 * Ingestion is idempotent: signals are stored by id, and memories are recomputed from all stored
 * signals in the lookback window, keyed by (scope, scopeId, key) so the same pattern updates one
 * memory instead of piling up duplicates.
 */
import type { AuditEvent, Proposal, ProposalOp } from '@ops/harness';
import { HarnessSignalSchema, type HarnessSignal, type HarnessSignalOf, type LineQty, type Memory, type MemoryEvidence, type MemoryScope, type SignalOp } from './model';
import type { ContextStore } from './store';
import { DAY_MS, groupBy, hashId, iso, median, money, round, safeLabel, systemClock, toNum, uniq, type ContextClock } from './util';

export interface MemoryOptions {
  clock?: ContextClock;
  /** Signals older than this are ignored when (re)learning. Default 180 days. */
  lookbackDays?: number;
  /** Learned confidence halves every this many days without confirmation. Default 60. */
  halfLifeDays?: number;
  /** Learned memories whose decayed confidence falls below this expire. Default 0.2. */
  minConfidence?: number;
}

/** Thresholds of the learners (exported for docs/tests). */
export const LEARNING_RULES = {
  qtyEdit: { minEdits: 3, minShare: 0.6, minAbsPct: 5 },
  approvedAsProposed: { minDecisions: 5, minShare: 0.9 },
  rejection: { minCount: 2 },
  complianceVeto: { minCount: 2 },
  policyDenied: { minCount: 3 },
} as const;

export type RejectionCategory = 'price' | 'quantity' | 'timing' | 'compliance' | 'duplicate' | 'vendor' | 'other';

const CATEGORY_PATTERNS: [RejectionCategory, RegExp][] = [
  ['compliance', /complian|lab|coa\b|metrc|test(ing)?\b|licen[sc]e|pesticide|recall/i],
  ['duplicate', /duplicate|already (ordered|have|placed)|dupe|double/i],
  ['price', /price|pricing|expensive|cost|overpriced|cheaper|margin/i],
  ['quantity', /quantit|too (many|much|few)|overstock|\bqty\b|units|case|smaller|larger/i],
  ['timing', /lead time|late|timing|too early|wait|next week|delay|hold off/i],
  ['vendor', /vendor|supplier|switch|different (vendor|supplier)/i],
];

const CATEGORY_LABEL: Record<RejectionCategory, string> = {
  price: 'price',
  quantity: 'quantity',
  timing: 'timing',
  compliance: 'compliance',
  duplicate: 'duplicates',
  vendor: 'vendor choice',
  other: 'other reasons',
};

export function categorizeReason(reason: string | null | undefined): RejectionCategory {
  if (!reason) return 'other';
  for (const [cat, re] of CATEGORY_PATTERNS) if (re.test(reason)) return cat;
  return 'other';
}

const COMPLIANCE_RULE = /complian|lab|coa|licen[sc]e|metrc/i;

interface Candidate {
  scope: MemoryScope;
  scopeId: string | null;
  key: string;
  statement: string;
  evidence: MemoryEvidence;
  evidenceCount: number;
  confidence: number;
  data: Memory['data'];
  /** Time of the latest supporting signal. */
  confirmedAt: string;
}

interface Names {
  vendor(id: string): string;
  product(id: string): string;
}

function evidenceOf(signals: readonly { id: string; proposalId?: string }[]): MemoryEvidence {
  return {
    proposalIds: uniq(signals.map((s) => s.proposalId).filter((p): p is string => !!p)),
    auditIds: uniq(signals.map((s) => s.id)),
    refs: [],
  };
}

const latestAt = (signals: readonly { at: string }[]) => signals.map((s) => s.at).sort().at(-1)!;
const strength = (k: number, n: number, adequateAt: number) => round((k / n) * Math.min(1, n / adequateAt), 2);

/** Relative quantity change of one op: matched lines (by product), final vs proposed. */
export function qtyChangePct(op: Pick<SignalOp, 'proposed' | 'final'>, productId?: string): number | null {
  const sumBy = (lines: readonly LineQty[]) => {
    const m = new Map<string, number>();
    for (const l of lines) if (l.productId && (!productId || l.productId === productId)) m.set(l.productId, (m.get(l.productId) ?? 0) + l.quantity);
    return m;
  };
  const before = sumBy(op.proposed);
  const after = sumBy(op.final);
  let b = 0;
  let a = 0;
  for (const [pid, q] of before) {
    b += q;
    a += after.get(pid) ?? 0; // a removed line counts as trimmed to 0
  }
  return b > 0 ? round(((a - b) / b) * 100, 1) : null;
}

interface EditObs {
  signal: HarnessSignalOf<'decision'>;
  pct: number;
}

function qtyEditCandidates(scope: 'vendor' | 'product', id: string, label: string, obs: EditObs[]): Candidate[] {
  const { minEdits, minShare, minAbsPct } = LEARNING_RULES.qtyEdit;
  const out: Candidate[] = [];
  const edits = obs.length;
  if (edits < minEdits) return out;
  const what = scope === 'vendor' ? `${label} POs` : `${label} lines`;
  for (const [key, verb, test] of [
    ['qty_trim', 'trims', (p: number) => p <= -minAbsPct],
    ['qty_raise', 'raises', (p: number) => p >= minAbsPct],
  ] as const) {
    const hits = obs.filter((o) => test(o.pct));
    if (hits.length < minEdits || hits.length / edits < minShare) continue;
    const med = median(hits.map((h) => h.pct))!;
    out.push({
      scope,
      scopeId: id,
      key,
      statement: `Approver ${verb} ${what} by ~${Math.abs(Math.round(med))}% (${hits.length} of ${edits} edits)`,
      evidence: evidenceOf(hits.map((h) => h.signal)),
      evidenceCount: hits.length,
      confidence: strength(hits.length, edits, 5),
      data: { hits: hits.length, edits, medianPct: round(med, 1) },
      confirmedAt: latestAt(hits.map((h) => h.signal)),
    });
  }
  return out;
}

/** The deterministic learners. Pure: signals + name lookup in, memory candidates out. */
export function learnFromSignals(signals: readonly HarnessSignal[], names: Names): Candidate[] {
  const out: Candidate[] = [];
  const decisions = signals.filter((s): s is HarnessSignalOf<'decision'> => s.kind === 'decision');

  // 1. approver quantity edits, per vendor and per product
  const vendorEdits = new Map<string, EditObs[]>();
  const productEdits = new Map<string, EditObs[]>();
  for (const d of decisions) {
    if (d.decision !== 'approve' || !d.edited) continue;
    for (const op of d.ops) {
      const pct = qtyChangePct(op);
      if (pct === null) continue;
      for (const v of uniq(op.vendorIds)) vendorEdits.set(v, [...(vendorEdits.get(v) ?? []), { signal: d, pct }]);
      for (const pid of uniq(op.proposed.map((l) => l.productId).filter((p): p is string => !!p))) {
        const ppct = qtyChangePct(op, pid);
        if (ppct !== null) productEdits.set(pid, [...(productEdits.get(pid) ?? []), { signal: d, pct: ppct }]);
      }
    }
  }
  for (const [v, obs] of vendorEdits) out.push(...qtyEditCandidates('vendor', v, names.vendor(v), obs));
  for (const [p, obs] of productEdits) out.push(...qtyEditCandidates('product', p, names.product(p), obs));

  // 2. vendors whose proposals are approved exactly as proposed
  const byVendor = new Map<string, HarnessSignalOf<'decision'>[]>();
  for (const d of decisions) for (const v of uniq(d.ops.flatMap((o) => o.vendorIds))) byVendor.set(v, [...(byVendor.get(v) ?? []), d]);
  for (const [v, ds] of byVendor) {
    const asIs = ds.filter((d) => d.decision === 'approve' && !d.edited);
    const { minDecisions, minShare } = LEARNING_RULES.approvedAsProposed;
    if (ds.length >= minDecisions && asIs.length / ds.length >= minShare) {
      out.push({
        scope: 'vendor',
        scopeId: v,
        key: 'approved_as_proposed',
        statement: `Approver approves ${names.vendor(v)} POs as proposed (${asIs.length} of ${ds.length} decisions)`,
        evidence: evidenceOf(asIs),
        evidenceCount: asIs.length,
        confidence: strength(asIs.length, ds.length, 8),
        data: { approvedAsIs: asIs.length, decisions: ds.length },
        confirmedAt: latestAt(asIs),
      });
    }
  }

  // 3. rejection reasons by vendor and by product
  const rejections = decisions.filter((d) => d.decision === 'reject');
  const rejectionCandidates = (scope: 'vendor' | 'product', id: string, label: string, rs: HarnessSignalOf<'decision'>[]) => {
    for (const [cat, hits] of groupBy(rs, (r) => categorizeReason(r.reason))) {
      if (hits.length < LEARNING_RULES.rejection.minCount || cat === 'other') continue;
      const examples = uniq(hits.map((h) => safeLabel(h.reason, 50)).filter(Boolean)).slice(0, 2);
      out.push({
        scope,
        scopeId: id,
        key: `rejection:${cat}`,
        statement: `${scope === 'vendor' ? `Proposals for ${label}` : `${label} lines`} are often rejected over ${CATEGORY_LABEL[cat]} (${hits.length} of ${rs.length} rejections${examples.length ? `; e.g. "${examples.join('", "')}"` : ''})`,
        evidence: evidenceOf(hits),
        evidenceCount: hits.length,
        confidence: strength(hits.length, rs.length, 4),
        data: { category: cat, hits: hits.length, rejections: rs.length },
        confirmedAt: latestAt(hits),
      });
    }
  };
  const rejByVendor = new Map<string, HarnessSignalOf<'decision'>[]>();
  const rejByProduct = new Map<string, HarnessSignalOf<'decision'>[]>();
  for (const r of rejections) {
    for (const v of uniq(r.ops.flatMap((o) => o.vendorIds))) rejByVendor.set(v, [...(rejByVendor.get(v) ?? []), r]);
    for (const p of uniq(r.ops.flatMap((o) => o.proposed.map((l) => l.productId)).filter((x): x is string => !!x))) rejByProduct.set(p, [...(rejByProduct.get(p) ?? []), r]);
  }
  for (const [v, rs] of rejByVendor) rejectionCandidates('vendor', v, names.vendor(v), rs);
  for (const [p, rs] of rejByProduct) rejectionCandidates('product', p, names.product(p), rs);

  // 4. compliance vetoes (explicit vetoes, compliance policy denials, compliance-reason rejections)
  const vetoes: { id: string; at: string; proposalId: string; vendorIds: string[]; productIds: string[]; note: string | null }[] = [];
  for (const s of signals) {
    if (s.kind === 'compliance_veto') vetoes.push({ id: s.id, at: s.at, proposalId: s.proposalId, vendorIds: s.vendorIds, productIds: s.productIds, note: s.reason });
    else if (s.kind === 'policy_denied' && s.rules.some((r) => COMPLIANCE_RULE.test(r)))
      vetoes.push({ id: s.id, at: s.at, proposalId: s.proposalId, vendorIds: s.vendorIds, productIds: s.productIds, note: s.messages[0] ?? null });
    else if (s.kind === 'decision' && s.decision === 'reject' && categorizeReason(s.reason) === 'compliance')
      vetoes.push({ id: s.id, at: s.at, proposalId: s.proposalId, vendorIds: uniq(s.ops.flatMap((o) => o.vendorIds)), productIds: uniq(s.ops.flatMap((o) => o.proposed.map((l) => l.productId)).filter((x): x is string => !!x)), note: s.reason });
  }
  // one veto per proposal (a veto often shows up as both a policy denial and a rejection)
  const vetoByProposal = [...groupBy(vetoes, (v) => v.proposalId).values()].map((vs) => vs.sort((a, b) => (a.at < b.at ? 1 : -1))[0]!);
  for (const [scope, idsOf] of [
    ['vendor', (v: (typeof vetoes)[number]) => v.vendorIds],
    ['product', (v: (typeof vetoes)[number]) => v.productIds],
  ] as const) {
    const by = new Map<string, typeof vetoes>();
    for (const v of vetoByProposal) for (const id of uniq(idsOf(v))) by.set(id, [...(by.get(id) ?? []), v]);
    for (const [id, vs] of by) {
      if (vs.length < LEARNING_RULES.complianceVeto.minCount) continue;
      const latest = [...vs].sort((a, b) => (a.at < b.at ? 1 : -1))[0]!;
      const label = scope === 'vendor' ? names.vendor(id) : names.product(id);
      out.push({
        scope,
        scopeId: id,
        key: 'compliance_veto',
        statement: `${label} has been vetoed by compliance ${vs.length} times${latest.note ? ` (latest: "${safeLabel(latest.note, 60)}")` : ''}`,
        evidence: { proposalIds: uniq(vs.map((v) => v.proposalId)), auditIds: uniq(vs.map((v) => v.id)), refs: [] },
        evidenceCount: vs.length,
        confidence: round(Math.min(1, vs.length / 3), 2),
        data: { vetoes: vs.length },
        confirmedAt: latest.at,
      });
    }
  }

  // 5. repeated policy denials per vendor and rule
  const denials = signals.filter((s): s is HarnessSignalOf<'policy_denied'> => s.kind === 'policy_denied');
  const denialKey = new Map<string, HarnessSignalOf<'policy_denied'>[]>();
  for (const d of denials) for (const v of uniq(d.vendorIds)) for (const r of uniq(d.rules)) denialKey.set(`${v}\u0000${r}`, [...(denialKey.get(`${v}\u0000${r}`) ?? []), d]);
  for (const [k, ds] of denialKey) {
    if (ds.length < LEARNING_RULES.policyDenied.minCount) continue;
    const [v, rule] = k.split('\u0000') as [string, string];
    out.push({
      scope: 'vendor',
      scopeId: v,
      key: `policy_denied:${rule}`,
      statement: `Proposals for ${names.vendor(v)} were denied by the ${rule} policy ${ds.length} times`,
      evidence: evidenceOf(ds),
      evidenceCount: ds.length,
      confidence: round(Math.min(1, ds.length / 5), 2),
      data: { rule, denials: ds.length },
      confirmedAt: latestAt(ds),
    });
  }

  // 6. policy rule revisions (caps raised/lowered, allowlists edited)
  const changes = signals.filter((s): s is HarnessSignalOf<'policy_rule_changed'> => s.kind === 'policy_rule_changed');
  for (const [key, cs] of groupBy(changes, (c) => c.key)) {
    const sorted = [...cs].sort((a, b) => (a.at < b.at ? -1 : 1));
    const last = sorted.at(-1)!;
    out.push({
      scope: 'global',
      scopeId: null,
      key: `policy:${key}`,
      statement: `${describeRuleChange(key, last)} (${cs.length} revision${cs.length === 1 ? '' : 's'} in window)`,
      evidence: { proposalIds: [], auditIds: sorted.map((c) => c.id), refs: [] },
      evidenceCount: cs.length,
      confidence: 1,
      data: { revisions: cs.length },
      confirmedAt: last.at,
    });
  }
  return out;
}

function describeRuleChange(key: string, c: HarnessSignalOf<'policy_rule_changed'>): string {
  const who = safeLabel(c.by.label ?? c.by.id, 40);
  const on = c.at.slice(0, 10);
  if (!c.after) return `Policy ${key} was removed by ${who} on ${on}`;
  if (!c.before) return `Policy ${key} was added by ${who} on ${on}`;
  const parts: string[] = [];
  for (const [field, after] of Object.entries(c.after)) {
    const before = c.before[field];
    const a = toNum(after);
    const b = toNum(before);
    if (a !== null && b !== null && a !== b) {
      const fmt = (n: number) => (/max|amount|value|cap/i.test(field) ? money(n) : String(n));
      parts.push(`${field} ${a > b ? 'raised' : 'lowered'} from ${fmt(b)} to ${fmt(a)}`);
    } else if (Array.isArray(after) && Array.isArray(before)) {
      const added = after.filter((x) => !before.includes(x)).length;
      const removed = before.filter((x) => !after.includes(x)).length;
      if (added || removed) parts.push(`${field}: +${added}/−${removed}`);
    }
  }
  return `Policy ${key}: ${parts.length ? parts.join(', ') : 'parameters changed'} by ${who} on ${on}`;
}

export function effectiveConfidence(m: Memory, now: Date, halfLifeDays = 60): number {
  if (m.origin === 'explicit') return m.confidence;
  const ageDays = Math.max(0, (now.getTime() - Date.parse(m.lastConfirmedAt)) / DAY_MS);
  return round(m.confidence * 0.5 ** (ageDays / halfLifeDays), 3);
}

export function isLive(m: Memory, now: Date, opts: Pick<MemoryOptions, 'halfLifeDays' | 'minConfidence'> = {}): boolean {
  if (m.status !== 'active') return false;
  if (m.expiresAt && Date.parse(m.expiresAt) <= now.getTime()) return false;
  return effectiveConfidence(m, now, opts.halfLifeDays) >= (opts.minConfidence ?? 0.2);
}

async function nameLookup(store: ContextStore): Promise<Names> {
  const [companies, products] = await Promise.all([store.list('company', { includeDeleted: true }), store.list('product', { includeDeleted: true })]);
  const vendors = new Map(companies.map((c) => [c.sourceId, safeLabel(c.name)]));
  const prods = new Map(products.map((p) => [p.sourceId, safeLabel(p.sku ? `${p.name} (${p.sku})` : p.name)]));
  return { vendor: (id) => vendors.get(id) ?? `vendor ${id}`, product: (id) => prods.get(id) ?? `product ${id}` };
}

export interface IngestResult {
  newSignals: number;
  upserted: Memory[];
  expired: string[];
}

/**
 * Learns memories from harness signals (see `signalsFromAudit` to build them from audit events).
 * Safe to call repeatedly with overlapping batches.
 */
export async function ingestHarnessEvents(store: ContextStore, signals: readonly unknown[], opts: MemoryOptions = {}): Promise<IngestResult> {
  const now = (opts.clock ?? systemClock).now();
  const parsed = signals.map((s) => HarnessSignalSchema.parse(s));
  const fresh = await store.appendSignals(parsed);
  const window = await store.listSignals(iso(now.getTime() - (opts.lookbackDays ?? 180) * DAY_MS));
  const candidates = learnFromSignals(window, await nameLookup(store));
  const upserted: Memory[] = [];
  const touched = new Set<string>();
  for (const c of candidates) {
    const id = `mem_${hashId('learned', c.scope, c.scopeId, c.key)}`;
    touched.add(id);
    const existing = await store.getMemory(id);
    if (existing?.status === 'retracted') continue; // a human said this is wrong; don't resurrect it
    const memory: Memory = {
      id,
      scope: c.scope,
      scopeId: c.scopeId,
      key: c.key,
      statement: c.statement,
      evidence: c.evidence,
      evidenceCount: c.evidenceCount,
      confidence: c.confidence,
      origin: 'learned',
      status: 'active',
      data: c.data,
      createdAt: existing?.createdAt ?? iso(now),
      lastConfirmedAt: c.confirmedAt,
      expiresAt: null,
    };
    const live = isLive(memory, now, opts);
    if (!live) memory.status = 'expired';
    if (!existing || JSON.stringify(existing) !== JSON.stringify(memory)) {
      await store.putMemory(memory);
      if (live) upserted.push(memory);
    }
  }
  // decay: memories no longer produced (or explicit ones past expiresAt) retire when they go stale
  const expired: string[] = [];
  for (const m of await store.listMemories({ statuses: ['active'] })) {
    if (touched.has(m.id)) continue;
    if (!isLive(m, now, opts)) {
      await store.putMemory({ ...m, status: 'expired' });
      expired.push(m.id);
    }
  }
  return { newSignals: fresh.length, upserted, expired };
}

export interface RememberInput {
  statement: string;
  scope: MemoryScope;
  scopeId?: string | null;
  evidence?: Partial<MemoryEvidence>;
  expiresAt?: string | null;
  /** Who said it (stored as a ref, e.g. `user:u-123`). */
  by?: string;
}

/** Explicit memory (e.g. a user in Copilot: "Mojave only delivers Tuesdays"). Deduped on normalized text + scope. */
export async function remember(store: ContextStore, input: RememberInput, opts: Pick<MemoryOptions, 'clock'> = {}): Promise<Memory> {
  const now = iso((opts.clock ?? systemClock).now());
  const statement = safeLabel(input.statement, 280);
  if (!statement) throw new Error('remember: statement is empty');
  const scopeId = input.scope === 'global' ? null : (input.scopeId ?? null);
  if (input.scope !== 'global' && !scopeId) throw new Error(`remember: scope '${input.scope}' needs a scopeId`);
  const id = `mem_${hashId('explicit', input.scope, scopeId, statement.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())}`;
  const existing = await store.getMemory(id);
  const merge = (a: string[] = [], b: string[] = []) => uniq([...a, ...b]);
  const evidence: MemoryEvidence = {
    proposalIds: merge(existing?.evidence.proposalIds, input.evidence?.proposalIds),
    auditIds: merge(existing?.evidence.auditIds, input.evidence?.auditIds),
    refs: merge(existing?.evidence.refs, [...(input.evidence?.refs ?? []), ...(input.by ? [input.by] : [])]),
  };
  const memory: Memory = {
    id,
    scope: input.scope,
    scopeId,
    key: 'explicit',
    statement: existing?.statement ?? statement,
    evidence,
    evidenceCount: evidence.proposalIds.length + evidence.auditIds.length + evidence.refs.length,
    confidence: 1,
    origin: 'explicit',
    status: 'active',
    data: { confirmations: Number(existing?.data.confirmations ?? 0) + 1 },
    createdAt: existing?.createdAt ?? now,
    lastConfirmedAt: now,
    expiresAt: input.expiresAt ?? existing?.expiresAt ?? null,
  };
  await store.putMemory(memory);
  return memory;
}

/** Retracts a memory (it is never re-learned while retracted). */
export async function forget(store: ContextStore, id: string): Promise<boolean> {
  const m = await store.getMemory(id);
  if (!m) return false;
  await store.putMemory({ ...m, status: 'retracted' });
  return true;
}

// ── harness audit events → signals ───────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Purchase-like lines from an op's input (`lines`/`items`) or payload: product id + quantity (+ price). */
export function linesOf(value: unknown): LineQty[] {
  if (!isRecord(value)) return [];
  const items = Array.isArray(value.lines) ? value.lines : Array.isArray(value.items) ? value.items : null;
  if (!items) return [];
  const out: LineQty[] = [];
  for (const i of items) {
    if (!isRecord(i)) continue;
    const quantity = toNum(i.quantity);
    if (quantity === null) continue;
    const pid = i.product_id ?? i.productId ?? null;
    out.push({ productId: typeof pid === 'string' ? pid : null, quantity, unitPrice: toNum(i.price ?? i.unit_price ?? i.unitPrice) });
  }
  return out;
}

function opLines(op: Pick<ProposalOp, 'input' | 'payload'>): LineQty[] {
  const fromInput = linesOf(op.input);
  return fromInput.length ? fromInput : linesOf(op.payload);
}

function vendorIdsOf(op: Pick<ProposalOp, 'vendorIds' | 'input' | 'payload'>): string[] {
  if (op.vendorIds?.length) return op.vendorIds;
  for (const v of [op.input, op.payload]) {
    if (isRecord(v)) {
      const id = v.vendor_id ?? v.company_id;
      if (typeof id === 'string') return [id];
    }
  }
  return [];
}

export interface SignalLookup {
  /** The proposal as it is now (after the decision; ops reflect approver edits). */
  proposal(id: string): Proposal | null | undefined;
  /** The ops as originally proposed (capture before `decide`, or keep in `proposal.meta.originalOps`). */
  proposedOps?(id: string): readonly ProposalOp[] | null | undefined;
  /** Whether an actor is the compliance reviewer/agent. Default: id or label contains "compliance". */
  isCompliance?(actor: { kind: string; id: string; label?: string }): boolean;
}

const defaultIsCompliance = (a: { id: string; label?: string }) => /complian/i.test(`${a.id} ${a.label ?? ''}`);

/**
 * Converts harness audit events into learner signals: `proposal.decided` → decision (with proposed
 * vs final lines), `policy.evaluated` deny → policy_denied, and a rejection by the compliance actor
 * → compliance_veto. Policy rule edits are not audit events; the Settings page emits
 * `policy_rule_changed` signals itself.
 */
export function signalsFromAudit(events: readonly AuditEvent[], lookup: SignalLookup): HarnessSignal[] {
  const out: HarnessSignal[] = [];
  const isCompliance = lookup.isCompliance ?? defaultIsCompliance;
  for (const e of events) {
    if (!e.proposalId) continue;
    const proposal = lookup.proposal(e.proposalId);
    if (!proposal) continue;
    const vendorIds = uniq(proposal.ops.flatMap((o) => vendorIdsOf(o)));
    const productIds = uniq(proposal.ops.flatMap((o) => opLines(o).map((l) => l.productId)).filter((p): p is string => !!p));
    if (e.type === 'proposal.decided') {
      const metaOps = isRecord(proposal.meta) && Array.isArray(proposal.meta.originalOps) ? (proposal.meta.originalOps as ProposalOp[]) : null;
      const original = lookup.proposedOps?.(e.proposalId) ?? metaOps ?? proposal.ops;
      const ops: SignalOp[] = proposal.ops.map((op) => {
        const orig = original.find((o) => o.index === op.index) ?? op;
        return { index: op.index, action: op.action, vendorIds: vendorIdsOf(op), proposed: opLines(orig), final: opLines(op) };
      });
      const by = { kind: e.actor.kind, id: e.actor.id, ...(e.actor.label ? { label: e.actor.label } : {}) };
      out.push({ id: e.id, at: e.at, kind: 'decision', proposalId: e.proposalId, decision: e.data.decision, reason: e.data.reason, edited: e.data.edited, by, ops });
      if (e.data.decision === 'reject' && isCompliance(e.actor)) {
        out.push({ id: `${e.id}:compliance`, at: e.at, kind: 'compliance_veto', proposalId: e.proposalId, vendorIds, productIds, reason: e.data.reason, by });
      }
    } else if (e.type === 'policy.evaluated' && e.data.outcome === 'deny') {
      const denied = e.data.reasons.filter((r) => r.outcome === 'deny');
      out.push({ id: e.id, at: e.at, kind: 'policy_denied', proposalId: e.proposalId, vendorIds, productIds, rules: uniq(denied.map((r) => r.rule)), messages: denied.map((r) => r.message) });
    }
  }
  return out;
}

