/**
 * The demo world the emulators are seeded with, matching apps/distru-mock's seed: Golden Coast
 * Distribution (a California cannabis distributor), its purchasing mailbox, its six vendors and the
 * demo operator/approver from apps/agent's seed.
 */

export const COMPANY = { name: 'Golden Coast Distribution', domain: 'goldencoastdistro.com' } as const;

/** The mailbox the Composio Gmail account is connected to (vendors' replies land here). */
export const PURCHASING = { email: 'purchasing@goldencoastdistro.com', name: 'Golden Coast Purchasing' } as const;

/** The Composio user id our Gmail / Calendar connected accounts belong to (one per tenant). */
export const COMPOSIO_USER_ID = 'golden-coast';

export interface Vendor {
  /** Short key used by the control endpoints (`vendor: 'MPR'` or the name / email). */
  key: string;
  name: string;
  email: string;
  contact: string;
  /** A SKU this vendor supplies, for realistic default replies. */
  sku: string;
  skuName: string;
}

/** Emails follow distru-mock's rule: `orders@<name lower-cased, letters only>.com`. */
export const VENDORS: readonly Vendor[] = [
  { key: 'HHF', name: 'Humboldt Heritage Farms', email: 'orders@humboldtheritagefarms.com', contact: 'Dana Whitlock', sku: 'FLW-BD-35', skuName: 'Blue Dream 3.5g' },
  { key: 'ETG', name: 'Emerald Triangle Growers', email: 'orders@emeraldtrianglegrowers.com', contact: 'Luis Ortega', sku: 'FLW-WC-35', skuName: 'Wedding Cake 3.5g' },
  { key: 'SEC', name: 'Sierra Extracts Co.', email: 'orders@sierraextractsco.com', contact: 'Priya Nair', sku: 'VAP-BD-1G', skuName: 'Blue Dream Live Resin Cart 1g' },
  { key: 'GSE', name: 'Golden State Edibles', email: 'orders@goldenstateedibles.com', contact: 'Marcus Bell', sku: 'EDB-CHO-DK', skuName: 'Dark Chocolate Bar 100mg' },
  { key: 'CCV', name: 'Coastal Cloud Vapes', email: 'orders@coastalcloudvapes.com', contact: 'Jenna Park', sku: 'VAP-PE-1G', skuName: 'Pineapple Express Cart 1g' },
  { key: 'MPR', name: 'Mojave Pre-Roll Co.', email: 'orders@mojaveprerollco.com', contact: 'Ray Delgado', sku: 'PRE-BD-1G', skuName: 'Blue Dream Pre-Roll 1g' },
];

/** Finds a vendor by key, name or email (case-insensitive). */
export function findVendor(ref: string): Vendor | undefined {
  const r = ref.trim().toLowerCase();
  return VENDORS.find((v) => v.key.toLowerCase() === r || v.name.toLowerCase() === r || v.email === r);
}

/** Slack members: the demo operator and approver (apps/agent seed) plus the purchasing manager. */
export const SLACK_USERS = [
  { name: 'olivia', real_name: 'Olivia Operator', email: 'operator@demo.dev' },
  { name: 'adam', real_name: 'Adam Approver', email: 'approver@demo.dev', is_admin: true },
  { name: 'sam', real_name: 'Sam Rivera', email: 'sam@goldencoastdistro.com' },
] as const;

export const SLACK_CHANNELS = ['purchasing', 'ops-approvals'] as const;
