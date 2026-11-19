/** Internal (storage) records. API shapes are produced from these by serialize.ts. */

export type TrackingMethod = 'PACKAGE' | 'PRODUCT' | 'BATCH';
export type OrderStatus = 'PENDING' | 'PROCESSING' | 'READY_TO_SHIP' | 'DELIVERING' | 'DELIVERED' | 'COMPLETED' | 'CANCELED';
export type PurchaseStatus = 'COMPLETED' | 'DELIVERING' | 'DRAFT' | 'PENDING' | 'PARTIALLY_RECEIVED' | 'PROCESSING';

export interface LicenseRec {
  id: string;
  license_number: string;
  license_type: string;
  active: boolean;
  issue_datetime: string;
  expiry_datetime: string;
  inserted_datetime: string;
}

export interface LocationRec {
  id: string;
  name: string;
  street_address: string;
  city: string;
  state: string;
  zip: string;
  latitude: number;
  longitude: number;
  license_id: string;
  /** null for our own locations; the partner company otherwise */
  company_id: string | null;
  metrc_id: number;
  inserted_datetime: string;
  updated_datetime: string;
}

export interface CompanyRec {
  id: string;
  name: string;
  legal_business_name: string;
  category: 'Cultivator' | 'Manufacturer' | 'Dispensary' | 'Distributor' | 'Retail';
  relationship: 'Vendor' | 'Customer';
  location_ids: string[];
  license_ids: string[];
  default_email: string;
  phone_number: string;
  website: string | null;
  default_purchase_order_notes: string | null;
  /** internal: typical lead time, not exposed (Distru has no such field) */
  lead_time_days: number;
  inserted_datetime: string;
  updated_datetime: string;
}

export interface CategoryRec {
  id: string;
  name: string;
}

export interface ProductRec {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  category_id: string;
  vendor_id: string;
  strain: { id: string; name: string; strain_type: 'INDICA' | 'SATIVA' | 'HYBRID' | 'INDICA_DOMINANT' | 'SATIVA_DOMINANT' | 'HIGH_CBD' } | null;
  unit_cost: number;
  unit_price: number;
  msrp: number;
  units_per_case: number | null;
  threshold_min: number | null;
  threshold_max: number | null;
  tracking: TrackingMethod;
  is_active: boolean;
  total_thc: number | null;
  total_cbd: number | null;
  cannabinoid_unit: 'PERCENT' | 'MG' | null;
  /** most units one buyer may put in one Distru Commerce menu order, on every menu (null = no cap) */
  max_menu_buyer_order_quantity?: number | null;
  /** Distru Commerce placement (default INCLUDE_IN_ALL) */
  menu_visibility?: 'DO_NOT_INCLUDE' | 'INCLUDE_IN_ALL' | 'INCLUDE_IN_SELECT';
  /** menus for INCLUDE_IN_SELECT */
  menu_ids?: string[];
  is_featured?: boolean;
  external_name?: string | null;
  inserted_datetime: string;
  updated_datetime: string;
}

export interface BatchRec {
  id: string;
  product_id: string;
  batch_number: string;
  manufactured_datetime: string;
  expiration_datetime: string | null;
  harvest_datetime: string | null;
  thc: number | null;
  cbd: number | null;
  unit_cost: number;
  inserted_datetime: string;
  updated_datetime: string;
}

/** A package (package-tracked) or a plain stock row (product-tracked). */
export interface LotRec {
  id: string;
  product_id: string;
  batch_id: string | null;
  location_id: string;
  quantity_initial: number;
  quantity: number;
  compliance_label: string | null;
  metrc_id: number | null;
  on_hold: boolean;
  inserted_datetime: string;
  updated_datetime: string;
}

export interface TestResultRec {
  id: string;
  batch_id: string;
  package_id: string | null;
  name: string;
  lab_name: string;
  lab_license_number: string;
  thc_percentage: number;
  cbd_percentage: number;
  total_thc_percentage: number;
  total_cbd_percentage: number;
  additional: Record<string, string>;
  release_date: string;
  coa_url: string;
  /** internal: drives the Metrc lab_testing_state */
  passed: boolean;
  metrc_id: number;
  inserted_datetime: string;
  updated_datetime: string;
}

export interface ChargeRec {
  id: string;
  name: string;
  type: 'CHARGE' | 'DISCOUNT';
  unit_type: 'PERCENT' | 'PRICE';
  price: number | null;
  percent: number | null;
  inserted_datetime: string;
}

export interface OrderItemRec {
  id: string;
  product_id: string;
  batch_id: string | null;
  package_id: string | null;
  location_id: string;
  quantity: number;
  price: number;
  price_base: number;
  is_sample: boolean;
  note: string | null;
  inserted_datetime: string;
}

export interface OrderRec {
  id: string;
  order_number: string;
  status: OrderStatus;
  company_id: string;
  location_id: string;
  billing_location_id: string | null;
  shipping_location_id: string | null;
  order_datetime: string;
  due_datetime: string;
  delivery_datetime: string | null;
  delivered_datetime: string | null;
  internal_notes: string | null;
  external_notes: string | null;
  items: OrderItemRec[];
  charges: ChargeRec[];
  /** Distru Commerce menu the order was placed from */
  menu_id?: string | null;
  inserted_datetime: string;
  updated_datetime: string;
}

export interface PurchaseItemRec {
  id: string;
  product_id: string | null;
  batch_id: string | null;
  package_id: string | null;
  location_id: string | null;
  quantity: number;
  price: number;
  received_quantity: number;
}

export interface PurchaseRec {
  id: string;
  purchase_number: string;
  status: PurchaseStatus;
  company_id: string | null;
  location_id: string | null;
  billing_location_id: string | null;
  supplier_location_id: string | null;
  order_datetime: string | null;
  due_datetime: string | null;
  description: string | null;
  owner_id: string | null;
  metrc_transfer_id: number | null;
  items: PurchaseItemRec[];
  charges: ChargeRec[];
  custom_data: Record<string, unknown>;
  inserted_datetime: string;
  updated_datetime: string;
}

export interface WebhookLogEntry {
  type: string;
  event: string;
  id: string;
  url: string;
  status: number | 'error';
  attempts: number;
  occurred_datetime: string;
  error?: string;
}

export interface SeedSummary {
  scenario: string;
  now: string;
  below_reorder_skus: string[];
  failed_lab_test: { batch_id: string; batch_number: string; sku: string; test_result_id: string } | null;
  prompt_injection: { product_id: string; sku: string } | null;
  calibration: { lead_time_days: number; service_level: number };
}

export interface UserRec {
  id: string;
  email: string;
  full_name: string;
  role: { id: string; name: string };
  is_admin: boolean;
  banned: boolean;
  inserted_datetime: string;
  updated_datetime: string;
}

export type TaskStatus = 'ACTIVE' | 'COMPLETED';
/** The record a task is linked to (at most one), REST field names. */
export type TaskLinkKind = 'order' | 'invoice' | 'purchase' | 'contact' | 'product' | 'batch' | 'assembly' | 'return' | 'company';

export interface TaskRec {
  id: string;
  name: string;
  description: string | null;
  status: TaskStatus;
  due_datetime: string;
  color: string | null;
  owner_id: string | null;
  creator_id: string | null;
  location_id: string | null;
  link: { kind: TaskLinkKind; id: string } | null;
  custom_data: Record<string, unknown>;
  inserted_datetime: string;
  updated_datetime: string;
}

export type CustomFieldType = 'checkbox' | 'date' | 'dropdown' | 'text';

export interface CustomFieldDefRec {
  id: number;
  name: string;
  description: string | null;
  /** REST parent object, e.g. `purchase`, `order`, `product`, `task`, `company` */
  parent_object: string;
  field_type: CustomFieldType;
  filterable: boolean;
  required: boolean;
  field_options: string[];
  disabled_field_options: string[];
  inserted_datetime: string;
}

export interface DeletedRecordRec {
  record_type: string;
  record_id: string;
  deleted_datetime: string;
}

export type ActivitySource = 'AI_AGENT' | 'AUTOMATION' | 'IMPORT' | 'JOB' | 'MCP' | 'METRC' | 'PUBLIC_API' | 'QUICKBOOKS' | 'WEB';

export interface HistoryFieldChange {
  field: string;
  label: string;
  old_value: unknown;
  new_value: unknown;
}

export interface HistoryRow {
  entity: string;
  entity_label: string;
  op: 'INSERT' | 'UPDATE' | 'DELETE';
  row_id: string | null;
  row_label: string | null;
  fields: HistoryFieldChange[];
}

/** One operation (a save, an API call, an MCP write), with the records it changed. */
export interface ActivityRec {
  id: string;
  changed_datetime: string;
  actor_id: string | null;
  source: ActivitySource;
  source_detail: string | null;
  records: {
    /** REST record-history type, e.g. PURCHASE, SALES_ORDER, PACKAGE, PRODUCT, BATCH; null when deleted with its rows */
    type: string | null;
    id: string;
    name: string | null;
    op: 'INSERT' | 'UPDATE' | 'DELETE';
    rows: HistoryRow[];
  }[];
}

export interface StockAdjustmentRec {
  id: string;
  quantity: number;
  reason: string | null;
  description: string | null;
  adjusted_datetime: string;
  location_id: string | null;
  package_id: string | null;
  batch_id: string | null;
  product_id: string;
  compliance_activity: { id: string; system: 'METRC'; status: 'QUEUED' | 'SUCCESS' | 'FAILED'; error: string | null } | null;
  source: ActivitySource;
  inserted_datetime: string;
}

/** An email the mock pretended to send (PDF emails); never actually sent. */
export interface OutboxEntry {
  id: string;
  at: string;
  source: ActivitySource;
  document: string;
  record_id: string;
  to: string[];
  subject: string;
}

/** Distru logs `intent` and `userSatisfactionEstimate` with every MCP call; so does the mock. */
export interface McpTelemetryEntry {
  at: string;
  tool: string;
  user_id: string;
  intent: string | null;
  user_satisfaction_estimate: number | null;
  /** false when the value was missing or invalid (Distru still runs the call) */
  intent_valid: boolean;
  satisfaction_valid: boolean;
  is_error: boolean;
}

export type OfficialCategory = 'CAPSULES' | 'CLONES' | 'CONCENTRATES' | 'EDIBLES' | 'FLOWER' | 'MERCH' | 'OTHER' | 'PREROLLS' | 'TINCTURES' | 'TOPICALS' | 'VAPES';

export interface MenuCollectionRec {
  id: string;
  name: string;
  is_hidden: boolean;
  only_featured_products: boolean;
  official_product_category_ids: OfficialCategory[];
  product_category_ids: string[];
  strain_ids: string[];
  strain_types: string[];
  thc_range: { min?: string; max?: string; unit: 'PERCENT' | 'MG' } | null;
  inserted_datetime: string;
  updated_datetime: string;
}

/** A DistruCommerce menu. Field names follow distru-mutate-menu (snake_case). */
export interface MenuRec {
  id: string;
  name: string;
  external_name: string;
  url_suffix: string;
  owner_id: string | null;
  active: boolean;
  visibility: 'PASSCODE_PROTECTED' | 'PRIVATE' | 'PUBLIC';
  passcode: string | null;
  location_ids: string[];
  allow_partner_orders: boolean;
  minimum_order_subtotal: number | null;
  minimum_order_lead_time_days: number;
  available_delivery_days: string[];
  buyer_can_select_delivery_date: boolean;
  sell_by_case_only: boolean;
  allow_customers_to_over_order: boolean;
  default_order_status: 'Pending' | 'Processing';
  buyer_default_order_owner_mode: 'CUSTOMERS_COMPANY_OWNER' | 'DEFAULT' | 'SPECIFIC_USER';
  buyer_default_order_owner_id: string | null;
  seller_default_order_owner_mode: 'CUSTOMERS_COMPANY_OWNER' | 'DEFAULT' | 'SALES_REP' | 'SPECIFIC_USER';
  seller_default_order_owner_id: string | null;
  allow_sales_reps_to_override_net_terms: boolean;
  auto_create_invoice_for_sales_rep_orders: boolean;
  show_inventory_levels: boolean;
  show_products_with_no_inventory_mode: 'DO_NOT_SHOW' | 'SHOW_AND_ALLOW_TO_ORDER' | 'SHOW_AS_SOLD_OUT';
  hide_prices_mode: 'DO_NOT_HIDE' | 'HIDE_FOR_EVERYONE' | 'HIDE_FOR_NON_LOGGED_IN_USERS';
  hide_original_price_when_price_tier_applied: boolean;
  allow_selling_by_potency: boolean;
  potency_official_product_category_ids: OfficialCategory[];
  show_coa: boolean;
  show_expiration_date: boolean;
  show_package_date: boolean;
  show_tac: boolean;
  show_total_cbd: boolean;
  allow_buyers_to_request_trade_samples: boolean;
  restrict_trade_sample_request_to_products_in_cart: boolean;
  send_internal_order_notifications: boolean;
  internal_order_notification_recipient_ids: string[];
  collections: MenuCollectionRec[];
  /** custom names for Distru's official collections */
  official_collection_names: Record<string, string>;
  inserted_datetime: string;
  updated_datetime: string;
}

// ── accounts receivable ──────────────────────────────────────────────────────────────────────

export type InvoiceStatus = 'NOT_PAID' | 'PARTIALLY_PAID' | 'FULLY_PAID' | 'OVER_PAID';

export interface PaymentMethodRec {
  id: string;
  name: string;
  type: 'CASH' | 'CHECK' | 'CREDIT_CARD' | 'BANK_REMITTANCE' | 'BANK_TRANSFER';
  active: boolean;
  inserted_datetime: string;
  updated_datetime: string;
}

export interface InvoiceItemRec {
  id: string;
  /** the billed sales order line */
  order_item_id: string;
  quantity: number;
  inserted_datetime: string;
}

/** A customer invoice, always generated from a sales order. Money is stored in dollars. */
export interface InvoiceRec {
  id: string;
  invoice_number: string;
  order_id: string;
  company_id: string;
  billing_location_id: string | null;
  invoice_datetime: string;
  due_datetime: string;
  payment_term_name: string | null;
  items: InvoiceItemRec[];
  charges: ChargeRec[];
  owner_id: string | null;
  creator_id: string | null;
  internal_notes: string | null;
  external_notes: string | null;
  voided_datetime: string | null;
  inserted_datetime: string;
  updated_datetime: string;
}

/** Money received against an invoice (payment_type INVOICE). */
export interface PaymentRec {
  id: string;
  payment_number: string;
  invoice_id: string;
  company_id: string;
  amount: number;
  payment_method_id: string | null;
  payment_datetime: string;
  description: string | null;
  status: 'POSTED' | 'VOIDED';
  quickbooks_deposit_account_id: string | null;
  quickbooks_deposit_account_name: string | null;
  /** excess over the invoice's remaining balance, turned into a customer credit */
  overpayment_credit: { id: string; credit_number: string; amount: number } | null;
  inserted_datetime: string;
  updated_datetime: string;
}
