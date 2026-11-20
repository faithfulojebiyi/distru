import type {
  Actor,
  PolicyOutcome,
  Principal,
  ProposalStatus,
  ProposalSummary,
} from '../../api/generated/opsAgentAPI.schemas';

/** The inbox tabs, each a set of statuses; the first is where an approver starts. */
export const INBOX_TABS = [
  { key: 'pending', label: 'Pending approval', statuses: ['pending_approval'] },
  { key: 'auto', label: 'Auto-approved', statuses: ['auto_approved'] },
  {
    key: 'executed',
    label: 'Executed',
    statuses: ['approved', 'executing', 'executed'],
  },
  {
    key: 'closed',
    label: 'Rejected / failed',
    statuses: ['rejected', 'failed', 'denied'],
  },
  { key: 'all', label: 'All', statuses: null },
] as const satisfies readonly {
  key: string;
  label: string;
  statuses: readonly ProposalStatus[] | null;
}[];

export type InboxTab = (typeof INBOX_TABS)[number]['key'];

export const isInboxTab = (value: unknown): value is InboxTab =>
  INBOX_TABS.some((tab) => tab.key === value);

export const inTab = (tab: InboxTab, status: ProposalStatus) => {
  const statuses = INBOX_TABS.find((item) => item.key === tab)?.statuses;
  return statuses ? (statuses as readonly ProposalStatus[]).includes(status) : true;
};

/** Statuses whose next change comes from the executor, so the detail keeps polling. */
export const LIVE_STATUSES: readonly ProposalStatus[] = [
  'approved',
  'auto_approved',
  'executing',
];

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const moneyShort = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

export const formatMoney = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : money.format(value);

/** Whole dollars for stat cards, cents everywhere a decision depends on them. */
export const formatMoneyShort = (value: number) =>
  value >= 100_000
    ? `$${(value / 1000).toFixed(0)}k`
    : moneyShort.format(value);

export const formatCount = (value: number) => value.toLocaleString();

/** "items[id=li-1].quantity" from ['items', 'id=li-1', 'quantity']; "new:0" reads as "new #1". */
export const formatPath = (path: readonly (string | number)[]) => {
  if (path.length === 0) return '(record)';
  return path
    .map((segment, index) => {
      if (typeof segment === 'number') return `[${segment}]`;
      if (segment.startsWith('new:'))
        return `[new #${Number(segment.slice(4)) + 1}]`;
      if (segment.includes('=')) return `[${segment}]`;
      return index === 0 ? segment : `.${segment}`;
    })
    .join('');
};

/** The last plain field name in a path, which decides how its value is formatted. */
export const fieldOf = (path: readonly (string | number)[]) => {
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const segment = path[index];
    if (typeof segment === 'string' && !segment.includes('=') && !segment.includes(':'))
      return segment;
  }
  return '';
};

const MONEY_FIELDS = new Set([
  'price',
  'unit_price',
  'total',
  'value',
  'cost',
  'unit_cost',
  'amount',
  'subtotal',
]);

const QUANTITY_FIELDS = new Set(['quantity', 'qty', 'units']);

export const isMoneyField = (field: string) => MONEY_FIELDS.has(field);
export const isQuantityField = (field: string) => QUANTITY_FIELDS.has(field);

/** A scalar as a person reads it: money as dollars, quantities with separators. */
export const formatScalar = (field: string, value: unknown): string => {
  if (value === null) return 'null';
  if (value === undefined) return '—';
  if (typeof value === 'number') {
    if (isMoneyField(field)) return money.format(value);
    return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
};

/** A record on one line ("price $9.35, quantity 120"), a scalar as formatScalar would show it. */
export const formatInline = (value: unknown, field = ''): string => {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return Object.entries(value)
      .map(([key, item]) => `${key} ${formatScalar(key, item)}`)
      .join(', ');
  if (Array.isArray(value)) return value.map((item) => formatInline(item, field)).join('; ');
  return formatScalar(field, value);
};

export const STATUS_LABELS: Record<ProposalStatus, string> = {
  draft: 'Draft',
  pending_approval: 'Needs approval',
  auto_approved: 'Auto-approved',
  denied: 'Denied by policy',
  approved: 'Approved',
  rejected: 'Rejected',
  executing: 'Executing',
  executed: 'Executed',
  failed: 'Failed',
};

export const POLICY_LABELS: Record<PolicyOutcome, string> = {
  allow: 'Policy: allow',
  needs_approval: 'Policy: needs approval',
  deny: 'Policy: deny',
};

/** Who proposed or did something, in words: "Procurement Planner", "Claude Code (MCP)". */
export const actorName = (actor: Principal | Actor) => {
  if (actor.kind === 'system') return 'Executor';
  if (actor.label) return actor.label;
  return actor.id;
};

export const ACTOR_KIND_LABELS: Record<Actor['kind'], string> = {
  agent: 'Agent',
  user: 'Person',
  'mcp-client': 'MCP client',
  system: 'System',
};

/** "4 min", "3 h", "2 d" since a timestamp. */
export const formatAge = (iso: string, now: number) => {
  const minutes = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
};

export const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

export const formatTime = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });

/** "distru.purchases.upsert" → "Purchase order". Unknown actions keep their registry name. */
const ACTION_LABELS: Record<string, string> = {
  'distru.purchases.upsert': 'Purchase order',
  'email.send_vendor_po': 'Vendor email',
  'distru.tasks.create': 'Receiving task',
  'distru_mcp.mutate_product': 'Buyer cap',
  'composio.gmail_reply_to_thread': 'Gmail reply',
  'composio.sheets.append_rows': 'Reorder log rows',
};

export const actionLabel = (action: string) => ACTION_LABELS[action] ?? action;

/** "2 purchase orders", "Purchase order + vendor email". */
export const opsSummary = (proposal: Pick<ProposalSummary, 'actions' | 'opCount'>) => {
  const counts = new Map<string, number>();
  for (const action of proposal.actions)
    counts.set(action, (counts.get(action) ?? 0) + 1);
  const parts = [...counts].map(([action, count]) =>
    count === 1
      ? actionLabel(action)
      : `${count} × ${actionLabel(action).toLowerCase()}`,
  );
  return parts.length ? parts.join(' + ') : 'No ops';
};

const startOfDay = (now: number) => {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

export const isToday = (iso: string, now: number) =>
  new Date(iso).getTime() >= startOfDay(now);

export const isThisWeek = (iso: string, now: number) =>
  new Date(iso).getTime() >= startOfDay(now) - 6 * 86_400_000;
