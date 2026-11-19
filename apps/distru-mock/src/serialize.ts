/** Internal records → API shapes, typed against the client's generated models (schema-faithful). */
import type {
  AdditionalTestResult,
  BatchFull,
  Charge,
  Company,
  CompanyCompact,
  Inventory,
  License,
  Invoice,
  Location,
  LocationCompact,
  LocationCompactWithCompany,
  LocationWithLicense,
  LocationWithLicenseAndCompany,
  MetrcPackage,
  Order,
  Package,
  Payment,
  PaymentMethod,
  Product,
  Purchase,
  PurchaseOrderItem,
  SalesOrderItem,
  TestResult,
  User,
} from '@ops/distru-client/model';
import { isOnMenu } from './menus';
import { customDataList } from './records';
import type { Store } from './store';
import { invoiceStatus, invoiceTotal, termFor } from './receivables';
import type {
  BatchRec,
  ChargeRec,
  CompanyRec,
  InvoiceRec,
  LicenseRec,
  LocationRec,
  LotRec,
  OrderItemRec,
  OrderRec,
  PaymentMethodRec,
  PaymentRec,
  ProductRec,
  PurchaseRec,
  TaskLinkKind,
  TaskRec,
  TestResultRec,
  UserRec,
} from './types';
import { fmtNum, isoDate, money } from './util';

const EACH = { id: 'unit-each', name: 'Each' };

export class Serializer {
  constructor(private readonly s: Store) {}

  license(l: LicenseRec): License {
    return {
      id: l.id,
      license_number: l.license_number,
      license_type: l.license_type,
      active: l.active,
      issue_datetime: l.issue_datetime,
      expiry_datetime: l.expiry_datetime,
      inserted_datetime: l.inserted_datetime,
    };
  }

  user(u: UserRec | string | null | undefined): User | null {
    const rec = typeof u === 'string' ? this.s.users.get(u) : u;
    if (!rec) return null;
    return {
      id: rec.id,
      email: rec.email,
      full_name: rec.full_name,
      role: rec.role,
      banned: rec.banned,
      deleted_at: null,
      inserted_datetime: rec.inserted_datetime,
      updated_datetime: rec.updated_datetime,
    };
  }

  /** Tasks linked to a record, as TaskCompact. */
  tasksFor(kind: TaskLinkKind, id: string) {
    return [...this.s.tasks.values()]
      .filter((t) => t.link?.kind === kind && t.link.id === id)
      .map((t) => ({ id: t.id, name: t.name, status: t.status, due_datetime: t.due_datetime }));
  }

  /** Full task (GET /public/v1/tasks, POST /public/v1/tasks). */
  task(t: TaskRec) {
    const s = this.s;
    const link = (kind: TaskLinkKind) => (t.link?.kind === kind ? t.link.id : null);
    const orderId = link('order');
    const purchaseId = link('purchase');
    const productId = link('product');
    const batchId = link('batch');
    const companyId = link('company');
    const o = orderId ? s.orders.get(orderId) : undefined;
    const pu = purchaseId ? s.purchases.get(purchaseId) : undefined;
    const pr = productId ? s.products.get(productId) : undefined;
    const b = batchId ? s.batches.get(batchId) : undefined;
    const co = companyId ? s.companies.get(companyId) : undefined;
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      status: t.status,
      due_datetime: t.due_datetime,
      color: t.color,
      owner: this.user(t.owner_id),
      creator: this.user(t.creator_id),
      location: this.locationCompact(t.location_id),
      order: o ? { id: o.id, order_number: o.order_number } : null,
      purchase: pu ? { id: pu.id, purchase_number: pu.purchase_number } : null,
      product: pr ? { id: pr.id, name: pr.name, sku: pr.sku } : null,
      batch: b ? { id: b.id, name: b.batch_number, batch_number: b.batch_number } : null,
      company: co ? { id: co.id, name: co.name } : null,
      invoice: null,
      contact: null,
      assembly: null,
      return: null,
      custom_data: customDataList(s, 'task', t.custom_data),
      inserted_datetime: t.inserted_datetime,
      updated_datetime: t.updated_datetime,
    };
  }

  private address(l: LocationRec) {
    return `${l.street_address}, ${l.city}, ${l.state} ${l.zip}`;
  }

  companyCompact(id: string | null): CompanyCompact | null {
    const c = id ? this.s.companies.get(id) : undefined;
    if (!c) return null;
    return { id: c.id, name: c.name, tasks: [], updated_datetime: c.updated_datetime };
  }

  locationCompact(id: string | null): LocationCompact | null {
    const l = id ? this.s.locations.get(id) : undefined;
    return l ? { id: l.id, name: l.name, address: this.address(l), license_id: l.license_id } : null;
  }

  locationWithLicense(id: string | null): LocationWithLicense | null {
    const l = id ? this.s.locations.get(id) : undefined;
    if (!l) return null;
    return { ...this.locationCompact(id)!, license_number: this.s.licenses.get(l.license_id)?.license_number ?? null };
  }

  locationWithLicenseAndCompany(id: string | null): LocationWithLicenseAndCompany | null {
    const l = id ? this.s.locations.get(id) : undefined;
    if (!l) return null;
    return { ...this.locationWithLicense(id)!, company: this.companyCompact(l.company_id ?? this.s.selfCompanyId) };
  }

  locationCompactWithCompany(id: string | null): LocationCompactWithCompany | null {
    const l = id ? this.s.locations.get(id) : undefined;
    if (!l) return null;
    return { ...this.locationCompact(id)!, company: this.companyCompact(l.company_id) };
  }

  location(l: LocationRec): Location {
    const lic = this.s.licenses.get(l.license_id);
    return {
      id: l.id,
      name: l.name,
      address: this.address(l),
      street_address: l.street_address,
      apt: null,
      city: l.city,
      state: l.state,
      zip: l.zip,
      country: 'US',
      latitude: l.latitude,
      longitude: l.longitude,
      license_id: l.license_id,
      license: lic ? this.license(lic) : null,
      company: this.companyCompact(l.company_id),
      metrc_id: l.metrc_id,
      deleted_at: null,
      inserted_datetime: l.inserted_datetime,
      updated_datetime: l.updated_datetime,
    };
  }

  company(c: CompanyRec): Company {
    const outstanding = c.relationship === 'Customer' ? this.customerBalance(c.id) : 0;
    return {
      id: c.id,
      name: c.name,
      legal_business_name: c.legal_business_name,
      category: c.category,
      relationship_type: { id: `rel-${c.relationship.toLowerCase()}`, name: c.relationship },
      custom_data: [],
      default_email: c.default_email,
      purchase_order_email: c.relationship === 'Vendor' ? c.default_email : null,
      sales_order_email: c.relationship === 'Customer' ? c.default_email : null,
      invoice_email: c.relationship === 'Customer' ? c.default_email : null,
      order_shipment_email: null,
      phone_number: c.phone_number,
      website: c.website,
      default_payment_term: null,
      default_purchase_order_notes: c.default_purchase_order_notes,
      default_sales_order_notes: null,
      deleted_at: null,
      group: null,
      leaflink_brand_id: null,
      leaflink_customer_id: null,
      licenses: c.license_ids.map((id) => this.license(this.s.licenses.get(id)!)),
      locations: c.location_ids.map((id) => this.locationCompactWithCompany(id)!),
      outstanding_balance: money(outstanding),
      outstanding_balance_threshold: null,
      past_due_balance: money(0),
      owner: null,
      owner_id: null,
      qb_customer_id: null,
      qb_vendor_id: null,
      inserted_datetime: c.inserted_datetime,
      updated_datetime: c.updated_datetime,
    };
  }

  private customerBalance(companyId: string): number {
    let s = 0;
    for (const o of this.s.orders.values()) if (o.company_id === companyId && o.status === 'DELIVERED') s += this.orderTotal(o);
    return s;
  }

  product(p: ProductRec, opts: { includeBatches?: boolean; includePackages?: boolean } = {}): Product {
    const s = this.s;
    const lots = s.lotsForProduct(p.id);
    const active = lots.reduce((a, l) => a + l.quantity, 0);
    const reserved = s.quantityReserved(p.id);
    const byLoc = new Map<string, LotRec[]>();
    for (const l of lots) if (l.quantity > 0) byLoc.set(l.location_id, [...(byLoc.get(l.location_id) ?? []), l]);
    const locIds = [...byLoc.keys()].sort((a, b) => (s.locations.get(a)!.name < s.locations.get(b)!.name ? -1 : 1));
    const cat = s.categories.get(p.category_id);
    const out: Product = {
      id: p.id,
      name: p.name,
      sku: p.sku,
      upc: null,
      description: p.description,
      description_markdown: p.description,
      external_name: p.external_name ?? null,
      category: cat ? { id: cat.id, name: cat.name, official_product_category_id: null } : null,
      subcategory: null,
      product_group: null,
      strain: p.strain
        ? { id: p.strain.id, name: p.strain.name, strain_type: p.strain.strain_type, inserted_datetime: p.inserted_datetime, updated_datetime: p.inserted_datetime }
        : null,
      vendor: this.companyCompact(p.vendor_id),
      brand: null,
      owner: null,
      creator: null,
      tags: [],
      tasks: [],
      images: [],
      menus: [...this.s.menus.values()]
        .filter((m) => isOnMenu({ ...p, is_active: true }, m.id))
        .sort((a, b) => (a.inserted_datetime === b.inserted_datetime ? a.id.localeCompare(b.id) : a.inserted_datetime < b.inserted_datetime ? -1 : 1))
        .map((m) => ({ id: m.id, name: m.name })),
      menu_visibility: p.menu_visibility ?? 'INCLUDE_IN_ALL',
      custom_data: [],
      inventory_tracking_method: p.tracking,
      is_active: p.is_active,
      is_featured: p.is_featured ?? false,
      leaflink_product_id: null,
      unit_type: EACH,
      unit_cost: money(p.unit_cost),
      unit_price: money(p.unit_price),
      wholesale_unit_price: p.unit_price,
      msrp: money(p.msrp),
      treez_wholesale_price: null,
      units_per_case: p.units_per_case == null ? null : String(p.units_per_case),
      quantity_active: fmtNum(active),
      quantity_reserved: fmtNum(reserved),
      quantity_available: fmtNum(active - reserved),
      quantity_active_by_location: locIds.map((id) => ({
        location: this.locationCompact(id)!,
        quantity: fmtNum(byLoc.get(id)!.reduce((a, l) => a + l.quantity, 0)),
      })),
      quantity_available_threshold_min: p.threshold_min == null ? null : fmtNum(p.threshold_min),
      quantity_available_threshold_max: p.threshold_max == null ? null : fmtNum(p.threshold_max),
      total_thc: p.total_thc == null ? null : fmtNum(p.total_thc),
      total_cbd: p.total_cbd == null ? null : fmtNum(p.total_cbd),
      total_cannabinoid_unit: p.cannabinoid_unit,
      gross_weight: null,
      gross_weight_unit_type: null,
      unit_net_weight: null,
      unit_net_weight_serving_size_unit_type: null,
      unit_serving_size: null,
      bill_of_materials: null,
      deleted_at: null,
      inserted_datetime: p.inserted_datetime,
      updated_datetime: p.updated_datetime,
    };
    if (opts.includeBatches) {
      out.batches_with_active_quantity_by_location = locIds.map((id) => {
        const perBatch = new Map<string, number>();
        for (const l of byLoc.get(id)!) if (l.batch_id) perBatch.set(l.batch_id, (perBatch.get(l.batch_id) ?? 0) + l.quantity);
        return {
          location: this.locationCompact(id)!,
          batches: [...perBatch].map(([bid, q]) => {
            const b = s.batches.get(bid)!;
            return { id: b.id, name: b.batch_number, batch_number: b.batch_number, quantity_active: fmtNum(q) };
          }),
        };
      });
    }
    if (opts.includePackages) {
      out.packages_with_active_quantity_by_location = locIds.map((id) => ({
        location: this.locationCompact(id)!,
        packages: byLoc.get(id)!.filter((l) => l.compliance_label).map((l) => this.package(l)),
      }));
    }
    return out;
  }

  package(l: LotRec): Package {
    const b = l.batch_id ? this.s.batches.get(l.batch_id) : undefined;
    const status: Package['distru_status'] = l.on_hold ? 'ONHOLD' : l.quantity > 0 ? 'ACTIVE' : 'FINISHED';
    return {
      id: l.id,
      batch_number: b?.batch_number ?? null,
      compliance_label: l.compliance_label,
      distru_status: status,
      license_id: this.s.locations.get(l.location_id)!.license_id,
      location_id: l.location_id,
      metrc_id: l.metrc_id,
      quantity: fmtNum(l.quantity_initial),
      quantity_active: fmtNum(l.quantity),
    };
  }

  private primaryTest(batchId: string): TestResultRec | undefined {
    return [...this.s.testResults.values()].find((t) => t.batch_id === batchId);
  }

  batch(b: BatchRec): BatchFull {
    const lots = [...this.s.lots.values()].filter((l) => l.batch_id === b.id);
    const active = lots.reduce((a, l) => a + l.quantity, 0);
    const byLoc = new Map<string, number>();
    for (const l of lots) if (l.quantity > 0) byLoc.set(l.location_id, (byLoc.get(l.location_id) ?? 0) + l.quantity);
    const t = this.primaryTest(b.id);
    return {
      id: b.id,
      name: b.batch_number,
      batch_number: b.batch_number,
      description: null,
      product_id: b.product_id,
      product: this.product(this.s.products.get(b.product_id)!),
      quantity_active: fmtNum(active),
      quantity_active_by_location: [...byLoc].map(([id, q]) => ({ location: this.locationCompact(id)!, quantity: fmtNum(q) })),
      manufactured_datetime: b.manufactured_datetime,
      expiration_datetime: b.expiration_datetime,
      harvest_datetime: b.harvest_datetime,
      thc: b.thc == null ? null : fmtNum(b.thc),
      cbd: b.cbd == null ? null : fmtNum(b.cbd),
      cost_per_unit_actual: money(b.unit_cost),
      cost_per_unit_default: money(b.unit_cost),
      total_cost_actual: money(b.unit_cost * active),
      total_cost_default: money(b.unit_cost * active),
      primary_test_result: t
        ? {
            name: t.name,
            coa_url: t.coa_url,
            thc_percentage: fmtNum(t.thc_percentage),
            thc_percentage_total: fmtNum(t.total_thc_percentage),
            cbd_percentage: fmtNum(t.cbd_percentage),
            cbd_percentage_total: fmtNum(t.total_cbd_percentage),
            mg_per_unit_type: null,
            thc_mg_per_unit: null,
            thc_mg_per_unit_total: null,
            cbd_mg_per_unit: null,
            cbd_mg_per_unit_total: null,
          }
        : null,
      bins: [],
      creator: null,
      owner_id: null,
      custom_data: [],
      tasks: [],
      deleted_at: null,
      inserted_datetime: b.inserted_datetime,
      updated_datetime: b.updated_datetime,
    };
  }

  testResult(t: TestResultRec): TestResult {
    return {
      id: t.id,
      name: t.name,
      is_primary: true,
      batch_id: t.batch_id,
      package_id: t.package_id,
      biotrack_id: null,
      metrc_id: t.metrc_id,
      lab_name: t.lab_name,
      lab_license_number: t.lab_license_number,
      release_date: t.release_date,
      coa_url: t.coa_url,
      thc_percentage: fmtNum(t.thc_percentage),
      cbd_percentage: fmtNum(t.cbd_percentage),
      total_thc_percentage: fmtNum(t.total_thc_percentage),
      total_cbd_percentage: fmtNum(t.total_cbd_percentage),
      mg_per_unit_type: null,
      thc_mg_per_unit: null,
      cbd_mg_per_unit: null,
      total_thc_mg_per_unit: null,
      total_cbd_mg_per_unit: null,
      additional_test_results: t.additional as AdditionalTestResult,
      inserted_datetime: t.inserted_datetime,
      updated_datetime: t.updated_datetime,
    };
  }

  metrcPackage(l: LotRec): MetrcPackage {
    const s = this.s;
    const p = s.products.get(l.product_id)!;
    const b = l.batch_id ? s.batches.get(l.batch_id) : undefined;
    const loc = s.locations.get(l.location_id)!;
    const lic = s.licenses.get(loc.license_id)!;
    const t = b ? this.primaryTest(b.id) : undefined;
    const cat = s.categories.get(p.category_id)!;
    const status: MetrcPackage['status'] = l.on_hold ? 'ONHOLD' : l.quantity > 0 ? 'ACTIVE' : 'FINISHED';
    return {
      id: l.metrc_id!,
      label: l.compliance_label,
      status,
      quantity: fmtNum(l.quantity),
      unit_type: EACH,
      item: {
        id: 300000 + [...s.products.keys()].indexOf(p.id),
        name: p.name,
        category_name: cat.name === 'Flower' ? 'Flower (packaged eighth - each)' : `${cat.name} (each)`,
        category_type: cat.name === 'Flower' ? 'Buds' : cat.name === 'Edibles' ? 'InfusedEdible' : 'Concentrate',
        quantity_type: 'COUNT_BASED',
        unit_type: EACH,
        strain: p.strain ? { id: 800 + p.strain.name.length, name: p.strain.name } : null,
        license: this.license(lic),
        is_deleted: false,
        inserted_datetime: p.inserted_datetime,
        updated_datetime: p.updated_datetime,
        fetched_datetime: new Date(s.now.getTime() - 3_600_000).toISOString(),
      },
      license: this.license(lic),
      location: { id: loc.metrc_id, name: loc.name },
      package: this.package(l),
      lab_testing_state: t ? (t.passed ? 'TestPassed' : 'TestFailed') : 'NotSubmitted',
      lab_testing_state_date: t?.release_date ?? null,
      production_batch_number: b?.batch_number ?? null,
      is_production_batch: false,
      is_testing_sample: false,
      is_trade_sample: false,
      is_finished_good: true,
      contains_remediated_product: false,
      product_requires_remediation: t ? !t.passed : false,
      remediation_date: null,
      packaged_date: b ? isoDate(new Date(b.manufactured_datetime)) : null,
      expiration_date: b?.expiration_datetime ? isoDate(new Date(b.expiration_datetime)) : null,
      finished_date: l.quantity > 0 ? null : isoDate(new Date(l.updated_datetime)),
      archived_date: null,
      note: l.on_hold ? 'Placed on hold: failed lab test' : null,
      received_datetime: l.inserted_datetime,
      received_from_facility_license_number: s.licenses.get(s.companies.get(p.vendor_id)!.license_ids[0]!)?.license_number ?? null,
      received_from_facility_name: s.companies.get(p.vendor_id)!.name,
      received_from_manifest_number: String(1_200_000 + (l.metrc_id ?? 0) % 100_000),
      source_harvest_names: b?.harvest_datetime ? `${p.strain?.name ?? p.name} ${isoDate(new Date(b.harvest_datetime))}` : null,
      source_package_labels: null,
      transferred_datetime: null,
      fetched_datetime: new Date(s.now.getTime() - 3_600_000).toISOString(),
      updated_datetime: l.updated_datetime,
    };
  }

  inventoryRow(group: { product_id: string; location_id?: string; batch_number?: string | null }, lots: LotRec[], reserved: number): Inventory {
    const active = lots.reduce((a, l) => a + l.quantity, 0);
    const cost = lots.reduce((a, l) => {
      const b = l.batch_id ? this.s.batches.get(l.batch_id) : undefined;
      return a + l.quantity * (b?.unit_cost ?? this.s.products.get(l.product_id)!.unit_cost);
    }, 0);
    const updated = lots.reduce((m, l) => (l.updated_datetime > m ? l.updated_datetime : m), lots[0]?.updated_datetime ?? new Date(0).toISOString());
    const row: Inventory = {
      product_id: group.product_id,
      active: active.toFixed(9),
      reserved: reserved.toFixed(9),
      available: (active - reserved).toFixed(9),
      total_cost_actual: active > 0 ? cost.toFixed(2) : null,
      total_cost_default: active > 0 ? cost.toFixed(2) : null,
      cost_per_unit_actual: active > 0 ? (cost / active).toFixed(2) : null,
      cost_per_unit_default: active > 0 ? (cost / active).toFixed(2) : null,
      updated_datetime: updated,
    };
    if ('location_id' in group) row.location_id = group.location_id ?? null;
    if ('batch_number' in group) row.batch_number = group.batch_number ?? null;
    return row;
  }

  charge(c: ChargeRec, subtotal: number): Charge {
    const amount = this.chargeAmount(c, subtotal);
    return {
      id: c.id,
      name: c.name,
      type: c.type,
      unit_type: c.unit_type,
      price: money(amount),
      percent: c.unit_type === 'PERCENT' ? fmtNum(c.type === 'DISCOUNT' ? -Math.abs(c.percent ?? 0) : (c.percent ?? 0)) : null,
      charge_preset: null,
      inserted_datetime: c.inserted_datetime,
    };
  }

  chargeAmount(c: ChargeRec, subtotal: number): number {
    const raw = c.unit_type === 'PERCENT' ? (subtotal * (c.percent ?? 0)) / 100 : (c.price ?? 0);
    return c.type === 'DISCOUNT' ? -Math.abs(raw) : Math.abs(raw);
  }

  orderTotal(o: OrderRec): number {
    const sub = o.items.reduce((a, i) => a + i.quantity * i.price, 0);
    return sub + o.charges.reduce((a, c) => a + this.chargeAmount(c, sub), 0);
  }

  purchaseTotal(p: PurchaseRec): number {
    const sub = p.items.reduce((a, i) => a + i.quantity * i.price, 0);
    return sub + p.charges.reduce((a, c) => a + this.chargeAmount(c, sub), 0);
  }

  /** A sales order line (also embedded in invoice items). */
  orderItem(i: OrderItemRec): SalesOrderItem {
    const lot = i.package_id ? this.s.lots.get(i.package_id) : undefined;
    const b = i.batch_id ? this.s.batches.get(i.batch_id) : undefined;
    const unitCost = b?.unit_cost ?? this.s.products.get(i.product_id)?.unit_cost ?? 0;
    return {
      id: i.id,
      product: this.product(this.s.products.get(i.product_id)!),
      batch: b ? { id: b.id, name: b.batch_number } : null,
      package: lot ? this.package(lot) : null,
      location: this.locationCompact(i.location_id),
      quantity: fmtNum(i.quantity),
      returned_quantity: '0',
      price: money(i.price),
      price_base: money(i.price_base),
      price_tier_mode: 'NONE',
      price_tier_version: null,
      is_sample: i.is_sample,
      note: i.note,
      compliance_quantity: lot ? fmtNum(i.quantity) : null,
      cost_per_unit: money(unitCost),
      cost_per_unit_default: money(unitCost),
      total_cost_actual: money(unitCost * i.quantity),
      total_cost_default: money(unitCost * i.quantity),
      thc_percentage_total: b?.thc == null ? null : fmtNum(b.thc),
      leaflink_id: null,
      inserted_datetime: i.inserted_datetime,
    };
  }

  order(o: OrderRec): Order {
    const sub = o.items.reduce((a, i) => a + i.quantity * i.price, 0);
    return {
      id: o.id,
      order_number: o.order_number,
      status: o.status,
      company: this.companyCompact(o.company_id),
      location: this.locationWithLicense(o.location_id),
      billing_location: this.locationWithLicenseAndCompany(o.billing_location_id),
      shipping_location: this.locationWithLicenseAndCompany(o.shipping_location_id),
      order_datetime: o.order_datetime,
      due_datetime: o.due_datetime,
      delivery_datetime: o.delivery_datetime,
      delivered_datetime: o.delivered_datetime,
      internal_notes: o.internal_notes,
      external_notes: o.external_notes,
      buyer_note: null,
      total: money(this.orderTotal(o)),
      items: o.items.map((i) => this.orderItem(i)),
      charges: o.charges.map((c) => this.charge(c, sub)),
      invoices: (this.s.invoiceIdsByOrder.get(o.id) ?? []).flatMap((id) => {
        const inv = this.s.invoices.get(id);
        return inv ? [this.compactInvoice(inv)] : [];
      }),
      returns: [],
      custom_data: customDataList(this.s, 'order', {}),
      tasks: this.tasksFor('order', o.id),
      owner: null,
      creator: null,
      menu: o.menu_id && this.s.menus.get(o.menu_id) ? { id: o.menu_id, name: this.s.menus.get(o.menu_id)!.name } : null,
      combined_order: null,
      biotrack_id: null,
      leaflink_id: null,
      leaflink_order_number: null,
      metrc_transfer_id: null,
      metrc_transfer_template_id: null,
      metrc_transfer_template_status: null,
      metrc_transfer_template_error: null,
      payment_term_name: termFor(this.s, o.company_id).term,
      inserted_datetime: o.inserted_datetime,
      updated_datetime: o.updated_datetime,
    };
  }

  purchase(p: PurchaseRec): Purchase {
    const sub = p.items.reduce((a, i) => a + i.quantity * i.price, 0);
    return {
      id: p.id,
      purchase_number: p.purchase_number,
      status: p.status,
      company: this.companyCompact(p.company_id),
      location: this.locationWithLicense(p.location_id),
      billing_location: this.locationWithLicense(p.billing_location_id),
      supplier_location: this.locationCompactWithCompany(p.supplier_location_id),
      order_datetime: p.order_datetime,
      due_datetime: p.due_datetime,
      description: p.description,
      total: money(this.purchaseTotal(p)),
      paid: money(p.status === 'COMPLETED' ? this.purchaseTotal(p) : 0),
      payment_status: p.status === 'COMPLETED' ? 'FULLY_PAID' : 'NOT_PAID',
      payments: [],
      items: p.items.map((i): PurchaseOrderItem => {
        const productId = i.product_id ?? (i.batch_id ? this.s.batches.get(i.batch_id)?.product_id ?? null : null);
        const b = i.batch_id ? this.s.batches.get(i.batch_id) : undefined;
        const lot = i.package_id ? this.s.lots.get(i.package_id) : undefined;
        return {
          id: i.id,
          product: productId ? this.product(this.s.products.get(productId)!) : null,
          batch: b ? { id: b.id, name: b.batch_number } : null,
          package: lot ? this.package(lot) : null,
          location: this.locationCompact(i.location_id),
          quantity: fmtNum(i.quantity),
          received_quantity: fmtNum(i.received_quantity),
          price: money(i.price),
          price_base: money(i.price),
          is_sample: false,
          compliance_quantity: lot ? fmtNum(i.received_quantity) : null,
        };
      }),
      charges: p.charges.map((c) => this.charge(c, sub)),
      custom_data: customDataList(this.s, 'purchase', p.custom_data),
      metrc_transfer_id: p.metrc_transfer_id,
      biotrack_id: null,
      qb_bill_id: null,
      owner: this.user(p.owner_id),
      creator: null,
      tasks: this.tasksFor('purchase', p.id),
      inserted_datetime: p.inserted_datetime,
      updated_datetime: p.updated_datetime,
    };
  }

  // ── accounts receivable ──────────────────────────────────────────────────────────────────

  paymentMethod(m: PaymentMethodRec): PaymentMethod {
    return { id: m.id, name: m.name, type: m.type, active: m.active, qb_payment_method_id: null, deleted_at: null, inserted_datetime: m.inserted_datetime, updated_datetime: m.updated_datetime };
  }

  compactInvoice(inv: InvoiceRec) {
    const total = invoiceTotal(this.s, inv);
    return { id: inv.id, invoice_number: inv.invoice_number, status: invoiceStatus(total, this.s.invoicePaid(inv.id)), total: money(total) };
  }

  /** `detail`: the show response (adds quickbooks_deposit_account_name); `created`: the creation response. */
  payment(p: PaymentRec, opts: { detail?: boolean; created?: boolean } = {}): Payment {
    const inv = this.s.invoices.get(p.invoice_id);
    const method = p.payment_method_id ? this.s.paymentMethods.get(p.payment_method_id) : undefined;
    const out: Payment = {
      id: p.id,
      payment_number: p.payment_number,
      payment_type: 'INVOICE',
      status: p.status,
      amount: fmtNum(p.amount, 2),
      payment_datetime: p.payment_datetime,
      description: p.description,
      company: this.companyCompact(p.company_id),
      invoice: inv ? this.compactInvoice(inv) : null,
      purchase: null,
      payment_method: method ? this.paymentMethod(method) : null,
      fully_paid_with_credits: false,
      credit_uses: [],
      overpayment_credits: p.overpayment_credit
        ? [{ id: p.overpayment_credit.id, credit_number: p.overpayment_credit.credit_number, amount: money(p.overpayment_credit.amount), source: 'INVOICE_PAYMENT' }]
        : [],
      quickbooks_deposit_account_id: p.quickbooks_deposit_account_id,
      inserted_datetime: p.inserted_datetime,
      updated_datetime: p.updated_datetime,
    };
    if (opts.detail || opts.created) out.quickbooks_deposit_account_name = p.quickbooks_deposit_account_name;
    if (opts.created) out.quickbooks_sync_enqueued = false;
    return out;
  }

  invoice(inv: InvoiceRec): Invoice {
    const s = this.s;
    const o = s.orders.get(inv.order_id);
    const total = invoiceTotal(s, inv);
    const paid = s.invoicePaid(inv.id);
    const sub = o ? o.items.reduce((a, i) => a + i.quantity * i.price, 0) : 0;
    const lines = new Map((o?.items ?? []).map((i) => [i.id, i]));
    return {
      id: inv.id,
      invoice_number: inv.invoice_number,
      status: invoiceStatus(total, paid),
      total: money(total),
      paid_amount: money(paid),
      remaining_amount: money(total - paid),
      invoice_datetime: inv.invoice_datetime,
      due_datetime: inv.due_datetime,
      payment_term_name: inv.payment_term_name,
      company: this.companyCompact(inv.company_id),
      billing_location: this.locationWithLicense(inv.billing_location_id),
      order: o ? { id: o.id, order_number: o.order_number, status: o.status, total: money(this.orderTotal(o)) } : null,
      owner: this.user(inv.owner_id),
      creator: this.user(inv.creator_id),
      items: inv.items.map((it) => {
        const line = lines.get(it.order_item_id);
        return { id: it.id, order_item_id: it.order_item_id, order_item: line ? this.orderItem(line) : null, quantity: fmtNum(it.quantity), description: null, inserted_datetime: it.inserted_datetime };
      }),
      charges: inv.charges.map((c) => this.charge(c, sub)),
      payments: s
        .paymentsOf(inv.id)
        .filter((p) => p.status === 'POSTED')
        .map((p) => this.payment(p)),
      custom_data: customDataList(s, 'invoice', {}),
      tasks: this.tasksFor('invoice', inv.id),
      internal_notes: inv.internal_notes,
      external_notes: inv.external_notes,
      voided_datetime: inv.voided_datetime,
      inserted_datetime: inv.inserted_datetime,
      updated_datetime: inv.updated_datetime,
    };
  }
}
