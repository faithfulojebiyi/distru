/**
 * Read/write classification and risk for MCP tools. Fail closed: a tool is a write unless something
 * positively says it is a read.
 *
 * Order (first match wins):
 *  1. explicit `classify` override from config
 *  2. `_meta.distru.kind` / `_meta.distru.reaches` (Distru convention, also used by our mock)
 *  3. a known-tool table from a preset (e.g. Distru's 114 tools), when `_meta` is missing
 *  4. MCP annotations: `readOnlyHint: true` → read; `destructiveHint: true` or `readOnlyHint: false` → write
 *  5. name heuristics: mutate|create|update|delete|adjust|send|email|split|move|finish|import|void|cancel|sync → write
 *  6. default: write
 */
import type { Risk } from '@ops/harness';
import { z } from 'zod';

export type ToolKind = 'read' | 'write';

/** The subset of an MCP `Tool` this package reads. */
export interface McpToolInfo {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean | undefined; destructiveHint?: boolean | undefined; idempotentHint?: boolean | undefined; title?: string | undefined } | undefined;
  _meta?: Record<string, unknown> | undefined;
}

export type ClassificationSource = 'override' | 'meta' | 'table' | 'annotations' | 'heuristic' | 'default';

export interface ToolClassification {
  kind: ToolKind;
  /** External systems a write reaches (lower-case: metrc, quickbooks, email…). */
  reaches: string[];
  destructive: boolean;
  /**
   * Which `action` values are destructive, when known: `['DELETE']` (Distru `_meta.distru.irreversible`
   * as a list), `['*']` (irreversible: true). Null when only `destructiveHint` says so (ambiguous).
   */
  destructiveActions: string[] | null;
  source: ClassificationSource;
}

export interface ClassifyOverride {
  kind: ToolKind;
  reaches?: readonly string[];
  destructive?: boolean;
}

/** Config hook: return a kind/override to force a classification, or undefined to fall through. */
export type ClassifyFn = (tool: McpToolInfo) => ToolKind | ClassifyOverride | undefined;

export type ToolTable = Readonly<Record<string, { kind: ToolKind; reaches: readonly string[] }>>;

/** Systems whose writes are always high risk: regulators, accounting, marketplaces, POS, people. */
export const HIGH_RISK_SYSTEMS: readonly string[] = ['metrc', 'biotrack', 'quickbooks', 'leaflink', 'pos', 'trym', 'email'];

export const WRITE_NAME_PATTERN = /(^|[^a-z])(mutate|create|update|delete|adjust|send|email|split|move|finish|import|void|cancel|sync)/i;

const DistruMeta = z.object({
  distru: z.object({
    kind: z.enum(['read', 'write']).optional(),
    reaches: z.array(z.string()).optional(),
    irreversible: z.union([z.boolean(), z.array(z.string())]).optional(),
  }),
});

const norm = (xs: readonly string[] | undefined) => [...new Set((xs ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean))];

/** Names that send to a person outside the company reach `email` even without metadata. */
const inferredReaches = (tool: McpToolInfo): string[] => (/(^|[^a-z])(e?mail|sms|text-message)/i.test(tool.name) ? ['email'] : []);

export function classifyTool(tool: McpToolInfo, options: { classify?: ClassifyFn | undefined; table?: ToolTable | undefined } = {}): ToolClassification {
  const withInferred = (r: string[]) => norm([...r, ...inferredReaches(tool)]);
  const meta = DistruMeta.safeParse(tool._meta ?? {});
  const irreversible = meta.success ? meta.data.distru.irreversible : undefined;
  // Destructiveness: Distru's `irreversible` is precise (per action); `destructiveHint` is not.
  const destructiveActions: string[] | null = irreversible === true ? ['*'] : Array.isArray(irreversible) && irreversible.length ? irreversible.map((a) => a.toUpperCase()) : null;
  const destructive = destructiveActions !== null || tool.annotations?.destructiveHint === true;
  const d = { destructive, destructiveActions };

  const override = options.classify?.(tool);
  if (override !== undefined) {
    const o: ClassifyOverride = typeof override === 'string' ? { kind: override } : override;
    return { kind: o.kind, reaches: withInferred(norm(o.reaches)), ...(o.destructive === undefined ? d : { destructive: o.destructive, destructiveActions: null }), source: 'override' };
  }

  if (meta.success && meta.data.distru.kind) {
    return { kind: meta.data.distru.kind, reaches: withInferred(norm(meta.data.distru.reaches)), ...d, source: 'meta' };
  }
  // `_meta.distru.reaches` without a kind still implies a write that reaches outside.
  const metaReaches = meta.success ? norm(meta.data.distru.reaches) : [];

  const known = options.table?.[tool.name];
  if (known) return { kind: known.kind, reaches: withInferred(norm([...known.reaches, ...metaReaches])), ...d, source: 'table' };

  if (metaReaches.length) return { kind: 'write', reaches: withInferred(metaReaches), ...d, source: 'meta' };

  const a = tool.annotations;
  if (a?.readOnlyHint === true && !destructive) return { kind: 'read', reaches: [], destructive: false, destructiveActions: null, source: 'annotations' };
  if (destructive || a?.readOnlyHint === false) return { kind: 'write', reaches: withInferred([]), ...d, source: 'annotations' };

  if (WRITE_NAME_PATTERN.test(tool.name)) return { kind: 'write', reaches: withInferred([]), ...d, source: 'heuristic' };

  return { kind: 'write', reaches: withInferred([]), ...d, source: 'default' };
}

/**
 * Whether a write is destructive for its non-DELETE actions. With an `action` enum that includes
 * DELETE, an unqualified `destructiveHint` is attributed to DELETE (Distru `mutate-*` convention).
 */
export function destructiveBeyondDelete(c: Pick<ToolClassification, 'destructive' | 'destructiveActions'>, actionValues: readonly string[]): boolean {
  if (c.destructiveActions) return c.destructiveActions.some((a) => a !== 'DELETE');
  return c.destructive && !actionValues.includes('DELETE');
}

/**
 * Risk of a write: high when it reaches a high-risk system, is destructive, or deletes; else medium.
 * Reads have no risk (they never go through propose).
 */
export function riskOf(c: Pick<ToolClassification, 'reaches' | 'destructive'>, opts: { deletes?: boolean; highRiskSystems?: readonly string[] } = {}): Risk {
  const high = new Set((opts.highRiskSystems ?? HIGH_RISK_SYSTEMS).map((s) => s.toLowerCase()));
  if (c.destructive || opts.deletes || c.reaches.some((r) => high.has(r))) return 'high';
  return 'medium';
}

/** `distru-mutate-purchase-order` → `mutate_purchase_order` (with `stripPrefix: 'distru-'`). */
export function localNameFor(toolName: string, stripPrefix?: string): string {
  let n = stripPrefix && toolName.startsWith(stripPrefix) ? toolName.slice(stripPrefix.length) : toolName;
  n = n.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(n)) n = `t_${n}`;
  return n;
}
