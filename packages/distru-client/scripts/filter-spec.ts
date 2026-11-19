/**
 * Filters the full Distru OpenAPI spec (openapi.json, ~1.3MB) down to the operations the Ops Agent
 * uses, keeping only the component schemas they transitively reference. Orval generates from the
 * filtered output (openapi.filtered.json) so the generated client stays small and tidy.
 *
 *   bun run scripts/filter-spec.ts
 */
import { join } from 'node:path';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type JsonObject = { [k: string]: Json };

/**
 * path → { method → operationId }. The upstream operationIds are Elixir controller names
 * (`DistruPublic.V1.ProductController.index`); we rename them so the generated functions read well
 * as agent tools (`listProducts`, `getProduct`, `upsertPurchase`, ...).
 */
export const KEEP: Record<string, Record<string, string>> = {
  '/public/v1/reports/inventory-velocity': { get: 'getInventoryVelocityReport' },
  '/public/v1/inventory': { get: 'listInventory' },
  '/public/v1/products': { get: 'listProducts' },
  '/public/v1/products/{id}': { get: 'getProduct' },
  '/public/v1/companies': { get: 'listCompanies' },
  '/public/v1/companies/{id}': { get: 'getCompany' },
  '/public/v1/locations': { get: 'listLocations' },
  '/public/v1/orders': { get: 'listOrders', post: 'upsertOrder' },
  '/public/v1/orders/{id}': { get: 'getOrder' },
  '/public/v1/purchases': { get: 'listPurchases', post: 'upsertPurchase' },
  '/public/v1/purchases/{id}': { get: 'getPurchase', delete: 'deletePurchase' },
  '/public/v1/metrc/packages': { get: 'listMetrcPackages' },
  '/public/v1/test-results': { get: 'listTestResults' },
  '/public/v1/test-results/{id}': { get: 'getTestResult' },
  '/public/v1/batches': { get: 'listBatches' },
  '/public/v1/batches/{id}': { get: 'getBatch' },
  // hand-off, sync and audit (added 2026-11-19)
  '/public/v1/purchases/{id}/pdf': { post: 'generatePurchasePdf' },
  '/public/v1/tasks': { get: 'listTasks', post: 'upsertTask' },
  '/public/v1/tasks/{id}': { get: 'getTask', delete: 'deleteTask' },
  '/public/v1/users': { get: 'listUsers' },
  '/public/v1/users/{id}': { get: 'getUser' },
  '/public/v1/custom-fields': { get: 'listCustomFields', post: 'createCustomField' },
  '/public/v1/custom-fields/{id}': { get: 'getCustomField' },
  '/public/v1/deleted-records': { get: 'listDeletedRecords' },
  '/public/v1/activity': { get: 'listActivity' },
  '/public/v1/record-history': { get: 'getRecordHistory' },
};

/**
 * Query params dropped from every operation:
 * - `page`: callers must never build page selectors; `paginate()` follows `next_page` instead.
 * - `custom_data`: a deep-object filter (`custom_data[123]=x`) Orval's fetch client cannot serialize.
 */
const DROP_PARAMS = new Set(['page', 'custom_data']);

const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

function collectRefs(node: Json, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const n of node) collectRefs(n, out);
  } else if (isObject(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') out.add(v);
      else collectRefs(v, out);
    }
  }
}

/**
 * Array query params are named `ids[]` in the spec, which would make callers write
 * `{ 'ids[]': [...] }`. We strip the brackets (callers write `{ ids: [...] }`) and record the names;
 * the mutator re-adds `[]` on the wire (see src/array-params.gen.ts).
 */
const arrayParams = new Set<string>();
const scalarParams = new Set<string>();

function normalizeOperation(op: JsonObject, operationId: string): JsonObject {
  const params = Array.isArray(op.parameters)
    ? op.parameters
        .filter((prm) => !(isObject(prm) && typeof prm.name === 'string' && DROP_PARAMS.has(prm.name)))
        .map((prm) => {
          if (!isObject(prm) || typeof prm.name !== 'string' || prm.in !== 'query') return prm;
          if (!prm.name.endsWith('[]')) {
            scalarParams.add(prm.name);
            return prm;
          }
          const name = prm.name.slice(0, -2);
          arrayParams.add(name);
          return { ...prm, name };
        })
    : op.parameters;
  // Distru declares responses as `*/*`; they are always JSON.
  const responses: JsonObject = {};
  for (const [status, res] of Object.entries((op.responses ?? {}) as JsonObject)) {
    if (isObject(res) && isObject(res.content) && res.content['*/*']) {
      const { ['*/*']: body, ...rest } = res.content;
      responses[status] = { ...res, content: { ...rest, 'application/json': body ?? null } };
    } else if (isObject(res) && isObject(res.content) && res.content['application/pdf,application/json']) {
      // PDF endpoints: binary for format=binary, JSON (PdfResponse) for url/email; type the JSON side
      responses[status] = { ...res, content: { 'application/json': res.content['application/pdf,application/json'] ?? null } };
    } else responses[status] = res;
  }
  return { ...op, operationId, ...(params ? { parameters: params } : {}), responses };
}

/**
 * Distru documents optional fields as "... or null when not set" (and `null` clears a field on
 * sparse updates) but never marks them `nullable`. Mark every non-required object property nullable
 * so the generated types tell the truth (`string | null`).
 */
function markOptionalNullable(node: Json): void {
  if (Array.isArray(node)) return node.forEach(markOptionalNullable);
  if (!isObject(node)) return;
  if (isObject(node.properties)) {
    const required = new Set(Array.isArray(node.required) ? node.required : []);
    for (const [name, prop] of Object.entries(node.properties)) {
      if (!isObject(prop) || required.has(name)) continue;
      if (typeof prop.$ref === 'string') node.properties[name] = { allOf: [prop], nullable: true };
      else prop.nullable = true;
    }
  }
  for (const v of Object.values(node)) markOptionalNullable(v);
}

export function filterSpec(spec: JsonObject): JsonObject {
  const paths = spec.paths as JsonObject;
  const components = (spec.components ?? {}) as JsonObject;
  const keptPaths: JsonObject = {};
  for (const [p, methods] of Object.entries(KEEP)) {
    const item = paths[p];
    if (!isObject(item)) throw new Error(`Path not found in spec: ${p}`);
    const kept: JsonObject = {};
    for (const [k, v] of Object.entries(item)) {
      if (k === 'parameters') kept[k] = v;
      const operationId = methods[k];
      if (operationId && isObject(v)) kept[k] = normalizeOperation(v, operationId);
    }
    keptPaths[p] = kept;
  }

  // transitive closure over #/components/<section>/<name> refs
  const seen = new Set<string>();
  const queue: string[] = [];
  const enqueue = (node: Json) => {
    const refs = new Set<string>();
    collectRefs(node, refs);
    for (const r of refs) if (!seen.has(r)) (seen.add(r), queue.push(r));
  };
  enqueue(keptPaths);
  while (queue.length) {
    const ref = queue.pop()!;
    const m = /^#\/components\/([^/]+)\/(.+)$/.exec(ref);
    if (!m) continue;
    const target = (components[m[1]!] as JsonObject | undefined)?.[m[2]!];
    if (target === undefined) throw new Error(`Dangling $ref: ${ref}`);
    enqueue(target);
  }

  const keptComponents: JsonObject = {};
  for (const ref of seen) {
    const [, section, name] = /^#\/components\/([^/]+)\/(.+)$/.exec(ref) ?? [];
    if (!section || !name) continue;
    const bucket = (keptComponents[section] ??= {}) as JsonObject;
    bucket[name] = (components[section] as JsonObject)[name]!;
  }
  if (components.securitySchemes) keptComponents.securitySchemes = components.securitySchemes;

  markOptionalNullable(keptComponents.schemas ?? null);
  for (const item of Object.values(keptPaths)) {
    for (const op of Object.values(item as JsonObject)) {
      if (isObject(op) && op.requestBody) markOptionalNullable(op.requestBody);
    }
  }
  return { ...spec, paths: keptPaths, components: keptComponents };
}

if (import.meta.main) {
  const root = join(import.meta.dir, '..');
  const spec = (await Bun.file(join(root, 'openapi.json')).json()) as JsonObject;
  const filtered = filterSpec(spec);
  const clash = [...arrayParams].filter((n) => scalarParams.has(n));
  if (clash.length) throw new Error(`params used both as array and scalar: ${clash.join(', ')}`);
  await Bun.write(join(root, 'openapi.filtered.json'), JSON.stringify(filtered, null, 2) + '\n');
  await Bun.write(
    join(root, 'src/array-params.gen.ts'),
    `// Generated by scripts/filter-spec.ts — do not edit.\n` +
      `// Query params that Distru expects with a trailing \`[]\` (e.g. \`ids[]=a&ids[]=b\`).\n` +
      `export const ARRAY_QUERY_PARAMS: ReadonlySet<string> = new Set(${JSON.stringify([...arrayParams].sort(), null, 2)});\n`,
  );
  const nSchemas = Object.keys(((filtered.components as JsonObject).schemas ?? {}) as JsonObject).length;
  console.log(`filtered spec: ${Object.keys(filtered.paths as JsonObject).length} paths, ${nSchemas} schemas`);
}
