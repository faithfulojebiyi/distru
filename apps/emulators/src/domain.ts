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

/**
 * The purchasing team's Google Sheets (Composio `googlesheets`), owned by the purchasing account.
 * Fixed ids so the agent's env can name them (COMPOSIO_GOOGLESHEETS_SPREADSHEETS, RESTOCK_REORDER_LOG_*).
 * Vendors, SKUs and unit costs match apps/distru-mock's catalogue.
 */
export const SHEETS = {
  vendorPrices: { id: '1GcVendorPriceSheet0goldencoast0000000000000', title: 'Vendor price sheet', tab: 'Prices' },
  reorderLog: { id: '1GcWeeklyReorderLog0goldencoast0000000000000', title: 'Weekly reorder log', tab: 'Reorders' },
} as const;

/** Columns of the weekly reorder log (A:J); `Ref` holds the Ops Agent's idempotency marker. */
export const REORDER_LOG_HEADER = ['Date', 'Run', 'PO', 'Vendor', 'SKU', 'Product', 'Qty', 'Unit cost', 'Location', 'Ref'] as const;

const vendorName = (key: string): string => VENDORS.find((v) => v.key === key)?.name ?? key;

/** [vendor key, SKU, product, unit cost, effective date, notes] */
const PRICES: readonly (readonly [string, string, string, number, string, string])[] = [
  ['HHF', 'FLW-BD-35', 'Blue Dream 3.5g', 14, '2026-07-01', ''],
  ['HHF', 'FLW-OGK-35', 'OG Kush 3.5g', 15, '2026-07-01', ''],
  ['HHF', 'FLW-GSC-35', 'Girl Scout Cookies 3.5g', 15.5, '2026-07-01', ''],
  ['HHF', 'FLW-GL-35', 'Gelato 3.5g', 16, '2026-07-01', ''],
  ['ETG', 'FLW-WC-35', 'Wedding Cake 3.5g', 16, '2026-08-15', 'Indoor; case of 24'],
  ['ETG', 'FLW-SD-35', 'Sour Diesel 3.5g', 14.5, '2026-08-15', ''],
  ['ETG', 'FLW-GG4-35', 'Gorilla Glue #4 3.5g', 15, '2026-08-15', ''],
  ['SEC', 'VAP-BD-1G', 'Blue Dream Live Resin Cart 1g', 18, '2026-09-01', ''],
  ['SEC', 'VAP-BD-1G', 'Blue Dream Live Resin Cart 1g', 19.5, '2026-12-15', 'Announced increase (extraction costs)'],
  ['SEC', 'CON-LR-BD', 'Blue Dream Live Resin 1g', 16, '2026-09-01', ''],
  ['SEC', 'VAP-NL-1G', 'Northern Lights Cart 1g', 16, '2026-09-01', ''],
  ['GSE', 'EDB-GUM-WM', 'Watermelon Gummies 100mg', 7, '2026-06-01', ''],
  ['GSE', 'EDB-CHO-DK', 'Dark Chocolate Bar 100mg', 8, '2026-06-01', 'Cacao supply tight; confirm lead time'],
  ['GSE', 'EDB-GUM-SB', 'Sour Blue Raspberry Gummies 100mg', 7, '2026-06-01', ''],
  ['CCV', 'VAP-PE-1G', 'Pineapple Express Cart 1g', 15, '2026-10-01', ''],
  ['CCV', 'VAP-GSC-05', 'GSC Cart 0.5g', 9, '2026-10-01', ''],
  ['CCV', 'VAP-WM-1G', 'Watermelon Distillate Cart 1g', 14, '2026-10-01', ''],
  ['MPR', 'PRE-BD-1G', 'Blue Dream Pre-Roll 1g', 4, '2026-05-01', 'Case of 50'],
  ['MPR', 'PRE-OGK-1G', 'OG Kush Pre-Roll 1g', 4, '2026-05-01', 'Case of 50'],
  ['MPR', 'PRE-INF-1G', 'Gelato Infused Pre-Roll 1g', 7, '2026-05-01', ''],
];

/** Past reorders, from the POs in the seeded vendor mail (src/history.ts): [date, PO, vendor key, SKU, product, qty, unit cost, location]. */
const PAST_REORDERS: readonly (readonly [string, string, string, string, string, number, number, string])[] = [
  ['2026-10-12', 'PO-515', 'CCV', 'VAP-PE-1G', 'Pineapple Express Cart 1g', 150, 15, 'Oakland Warehouse'],
  ['2026-10-14', 'PO-509', 'SEC', 'VAP-BD-1G', 'Blue Dream Live Resin Cart 1g', 150, 18, 'Los Angeles Distribution Center'],
  ['2026-10-23', 'PO-503', 'HHF', 'FLW-BD-35', 'Blue Dream 3.5g', 240, 14, 'Oakland Warehouse'],
  ['2026-11-14', 'PO-519', 'GSE', 'EDB-CHO-DK', 'Dark Chocolate Bar 100mg', 48, 8, 'Oakland Warehouse'],
];

/** The spreadsheets the purchasing account owns, as `seedGoogle({ sheets })` takes them. */
export function sheetsSeed() {
  return [
    {
      spreadsheetId: SHEETS.vendorPrices.id,
      title: SHEETS.vendorPrices.title,
      tabs: [
        {
          title: SHEETS.vendorPrices.tab,
          values: [['Vendor', 'SKU', 'Product', 'Unit cost', 'Effective date', 'Notes'], ...PRICES.map(([v, sku, name, cost, date, notes]) => [vendorName(v), sku, name, cost.toFixed(2), date, notes])],
        },
      ],
    },
    {
      spreadsheetId: SHEETS.reorderLog.id,
      title: SHEETS.reorderLog.title,
      tabs: [
        {
          title: SHEETS.reorderLog.tab,
          values: [
            [...REORDER_LOG_HEADER],
            ...PAST_REORDERS.map(([date, po, v, sku, name, qty, cost, location]) => [date, 'manual', po, vendorName(v), sku, name, String(qty), cost.toFixed(2), location, '']),
          ],
        },
      ],
    },
  ];
}
