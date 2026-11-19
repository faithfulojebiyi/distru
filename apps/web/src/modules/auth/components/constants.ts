import type { WelcomeTask } from './types';

/** Faint ERP records behind the welcome copy: example data, shaped like inventory and purchase order rows. */
export const LEDGER_LINES = [
  'GET /public/v1/reports/inventory-velocity?below_reorder_point=true  200  14 rows',
  'sku=FLW-BD-3.5G-0142  on_hand=18   velocity=6.2/d   reorder_point=40  days_of_supply=2.9',
  'sku=VPE-CRT-1G-0087   on_hand=52   velocity=4.1/d   reorder_point=60  days_of_supply=12.7',
  'sku=EDB-GUM-10PK-0311 on_hand=9    velocity=3.8/d   reorder_point=30  days_of_supply=2.4',
  'vendor=GREEN-VALLEY-FARMS  lead_time=9d  last_po=PO-20931  unit_cost=14.25',
  'proposal=prp_7f2c  op=upsert  resource=purchase  lines=3  total=$4,812.00',
  '  + line  FLW-BD-3.5G-0142  qty=160  unit=$14.25',
  '  + line  EDB-GUM-10PK-0311 qty=120  unit=$9.80',
  'policy  max_po_total=$10,000  vendor_allowlist=ok  auto_approve=false',
  'metrc   package=1A4060300003B11000012345  lab=passed  status=active',
  'idempotency_key=prp_7f2c:op1  lookup=miss  write=ok  verify=match',
];

/** The restock work the welcome panel shows rising in. */
export const WELCOME_TASKS: WelcomeTask[] = [
  {
    code: 'SKU',
    title: 'Blue Dream 3.5g at 2.9 days of supply',
    detail: 'Velocity 6.2/day · below reorder point',
    tone: 'done',
    status: 'Found',
  },
  {
    code: 'PO',
    title: 'Draft PO to Green Valley Farms',
    detail: 'Sizing 160 units against a 9 day lead time',
    tone: 'working',
    status: 'Drafting',
    typing: true,
  },
  {
    code: 'DIFF',
    title: '3 line purchase order · $4,812',
    detail: 'Policy checks passed · compliance clear',
    tone: 'needs',
    status: 'Needs approval',
  },
  {
    code: '',
    title: 'Approved by the ops lead',
    detail: 'Written once, verified, audited',
    tone: 'done',
    status: 'Applied',
  },
];
