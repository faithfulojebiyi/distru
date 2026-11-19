/**
 * Distru MCP ids carry a prefix naming the record kind (docs/research/mcp/mcp_conventions.md): `com_1`
 * for a company, `inv_4` for an invoice. Inputs also take the same id without a prefix (as the
 * public API returns it), and a prefix of the wrong kind is refused.
 *
 * The mock maps them 1:1 onto the REST store ids: `<prefix>_<rest id>`.
 * Documented prefixes: com (company), inv (invoice), so (sales order), po (purchase order),
 * pkg (package), batch (batch), asm (assembly), test (test result).
 * Assumed (not in the docs we have): prd, loc, lic, usr, task, cat, adj, act, poi, soi, chg, cf, menu, mcol.
 */
export const PREFIX = {
  company: 'com',
  invoice: 'inv',
  salesOrder: 'so',
  purchaseOrder: 'po',
  package: 'pkg',
  batch: 'batch',
  assembly: 'asm',
  testResult: 'test',
  product: 'prd',
  location: 'loc',
  license: 'lic',
  user: 'usr',
  task: 'task',
  category: 'cat',
  stockAdjustment: 'adj',
  activity: 'act',
  purchaseOrderItem: 'poi',
  salesOrderItem: 'soi',
  charge: 'chg',
  customField: 'cf',
  menu: 'menu',
  menuCollection: 'mcol',
} as const;

export type IdKind = keyof typeof PREFIX;

const KIND_BY_PREFIX = new Map<string, IdKind>(Object.entries(PREFIX).map(([k, p]) => [p, k as IdKind]));
const LABEL: Record<IdKind, string> = {
  company: 'company',
  invoice: 'invoice',
  salesOrder: 'sales order',
  purchaseOrder: 'purchase order',
  package: 'package',
  batch: 'batch',
  assembly: 'assembly',
  testResult: 'test result',
  product: 'product',
  location: 'location',
  license: 'license',
  user: 'user',
  task: 'task',
  category: 'category',
  stockAdjustment: 'stock adjustment',
  activity: 'activity entry',
  purchaseOrderItem: 'purchase order line',
  salesOrderItem: 'sales order line',
  charge: 'charge',
  customField: 'custom field',
  menu: 'menu',
  menuCollection: 'menu collection',
};

export class IdError extends Error {
  constructor(
    message: string,
    readonly path: (string | number)[],
  ) {
    super(message);
  }
}

/** `<prefix>_<id>`; null stays null. */
export function toMcpId(kind: IdKind, id: string | number | null | undefined): string | null {
  if (id === null || id === undefined || id === '') return null;
  return `${PREFIX[kind]}_${id}`;
}

/** Same as toMcpId for ids that are always present. */
export const mid = (kind: IdKind, id: string | number) => `${PREFIX[kind]}_${id}`;

/**
 * Accepts `<prefix>_<id>` for the right kind or a bare id; refuses a known prefix of another kind.
 */
export function fromMcpId(kind: IdKind, value: string, path: (string | number)[] = []): string {
  const m = /^([a-z]+)_(.+)$/.exec(value);
  if (m) {
    const other = KIND_BY_PREFIX.get(m[1]!);
    if (other === kind) return m[2]!;
    if (other) throw new IdError(`${value} is a ${LABEL[other]} id; expected a ${LABEL[kind]} id (${PREFIX[kind]}_…)`, path);
  }
  return value;
}

export function fromMcpIds(kind: IdKind, values: string[] | undefined, path: (string | number)[] = []): string[] | undefined {
  return values?.map((v, i) => fromMcpId(kind, v, [...path, i]));
}
