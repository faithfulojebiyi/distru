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
