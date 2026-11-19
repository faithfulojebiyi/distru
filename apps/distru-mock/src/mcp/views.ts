/**
 * Store records → Distru MCP output shapes (camelCase, prefixed ids), following the Output tables of
 * docs/research/mcptools/*.md. Fields Distru has but our store doesn't model are returned as null
 * (or left out when the table says "Can be absent").
 */
import { serializeActivity } from '../history';
import { colorName } from '../records';
import type { Serializer } from '../serialize';
import { SELF_COMPANY, type Store } from '../store';
import { isOnMenu, menuAvailable, menuProducts, OFFICIAL_COLLECTIONS, OFFICIAL_NAMES, officialCategoryOf } from '../menus';
import type { ActivityRec, CompanyRec, LotRec, MenuCollectionRec, MenuRec, OrderRec, ProductRec, PurchaseRec, StockAdjustmentRec, TaskRec, TestResultRec, UserRec } from '../types';
import { fmtNum, money } from '../util';
import { mid, toMcpId } from './ids';

const APP = 'https://app.distru.com';
const EACH = { id: 'ut_each', name: 'Each' };
const FIELD_TYPE: Record<string, string> = { text: 'TEXT', date: 'DATE', dropdown: 'DROPDOWN', checkbox: 'CHECKBOX' };

export class McpViews {
  constructor(
    private readonly s: Store,
    private readonly ser: Serializer,
  ) {}

  customFields(parent: string, values: Record<string, unknown>) {
    return [...this.s.customFields.values()]
      .filter((d) => d.parent_object === parent)
      .map((d) => {
        const v = values[String(d.id)];
        return {
          customField: { id: mid('customField', d.id), name: d.name, fieldType: FIELD_TYPE[d.field_type] ?? 'TEXT' },
          value: v === undefined || v === null ? null : Array.isArray(v) ? v.join(', ') : d.field_type === 'date' ? String(v).slice(0, 10) : String(v),
        };
      });
  }

  userRef(id: string | null) {
    const u = id ? this.s.users.get(id) : undefined;
    return u ? { id: mid('user', u.id), profile: { fullName: u.full_name } } : null;
  }

  locationRef(id: string | null, withAddress = true) {
    const l = id ? this.s.locations.get(id) : undefined;
    if (!l) return null;
    return withAddress ? { id: mid('location', l.id), name: l.name, address: `${l.street_address}, ${l.city}, ${l.state} ${l.zip}` } : { id: mid('location', l.id), name: l.name };
  }

  companyRef(id: string | null) {
    if (!id) return null;
    if (id === this.s.selfCompanyId) return { id: mid('company', id), name: this.s.selfCompanyName };
    const c = this.s.companies.get(id);
    return c ? { id: mid('company', c.id), name: c.name } : null;
  }

  // ── products ─────────────────────────────────────────────────────────────────────────────────

  private productQuantities(p: ProductRec) {
    const s = this.s;
    const lots = s.lotsForProduct(p.id);
    const active = lots.reduce((a, l) => a + l.quantity, 0);
    const reserved = s.quantityReserved(p.id);
    const passed =
      p.tracking === 'PACKAGE'
        ? lots
            .filter((l) => {
              const t = l.batch_id ? [...s.testResults.values()].find((x) => x.batch_id === l.batch_id) : undefined;
              return t?.passed;
            })
            .reduce((a, l) => a + l.quantity, 0)
        : null;
    const cost = lots.reduce((a, l) => a + l.quantity * ((l.batch_id ? s.batches.get(l.batch_id)?.unit_cost : undefined) ?? p.unit_cost), 0);
    const byLoc = new Map<string, number>();
    for (const l of lots) if (l.quantity > 0) byLoc.set(l.location_id, (byLoc.get(l.location_id) ?? 0) + l.quantity);
    return { active, reserved, passed, cost, byLoc, incoming: s.quantityIncoming(p.id) };
  }

  productRow(p: ProductRec) {
    const s = this.s;
    const q = this.productQuantities(p);
    const cat = s.categories.get(p.category_id);
    return {
      id: mid('product', p.id),
      customFields: this.customFields('product', {}),
      name: p.name,
      sku: p.sku,
      upc: null,
      isInactive: !p.is_active,
      inventoryTrackingMethod: p.tracking,
      unitPrice: money(p.unit_price),
      wholesaleUnitPrice: money(p.unit_price),
      unitCost: money(p.unit_cost),
      activeQuantityCost: q.active > 0 ? money(q.cost) : null,
      unitsPerCase: p.units_per_case == null ? null : String(p.units_per_case),
      quantityActive: fmtNum(q.active),
      quantityActivePassedTesting: q.passed === null ? null : fmtNum(q.passed),
      quantityAssembling: '0',
      quantityAvailable: fmtNum(q.active - q.reserved),
      quantityIncoming: fmtNum(q.incoming),
      quantityPendingOutput: '0',
      quantityPossible: null,
      quantityReserved: fmtNum(q.reserved),
      quantityAvailableThresholdMin: p.threshold_min == null ? null : fmtNum(p.threshold_min),
      quantityAvailableThresholdMax: p.threshold_max == null ? null : fmtNum(p.threshold_max),
      unitNetWeight: null,
      unitNetWeightAndServingSizeUnitType: null,
      activeQuantitiesByLocation: [...q.byLoc].map(([id, n]) => ({ location: this.locationRef(id, false)!, quantity: fmtNum(n) })),
      totalThc: p.total_thc == null ? null : fmtNum(p.total_thc),
      totalCbd: p.total_cbd == null ? null : fmtNum(p.total_cbd),
      totalCannabinoidUnit: p.cannabinoid_unit,
      insertedAt: p.inserted_datetime,
      updatedAt: p.updated_datetime,
      category: cat ? { id: mid('category', cat.id), name: cat.name } : null,
      subcategory: null,
      group: null,
      tags: [],
      unitType: EACH,
      strain: p.strain ? { id: p.strain.id, name: p.strain.name } : null,
      brand: null,
      vendor: this.companyRef(p.vendor_id),
      quickbooksSalesItem: null,
      quickbooksPurchaseItem: null,
    };
  }

  productFull(
    p: ProductRec,
    inc: { images?: boolean; tags?: boolean; byLocation?: boolean; costItems?: boolean; bom?: boolean } = {},
  ) {
    const row = this.productRow(p);
    const q = this.productQuantities(p);
    const out: Record<string, unknown> = {
      id: row.id,
      customFields: row.customFields,
      name: p.name,
      externalName: p.external_name ?? null,
      sku: p.sku,
      upc: null,
      description: p.description,
      descriptionMarkdown: p.description,
      isInactive: !p.is_active,
      isFeatured: p.is_featured ?? false,
      maxMenuBuyerOrderQuantity: p.max_menu_buyer_order_quantity ?? null,
      inventoryTrackingMethod: p.tracking,
      unitCost: row.unitCost,
      activeQuantityCost: row.activeQuantityCost,
      unitPrice: row.unitPrice,
      wholesaleUnitPrice: row.wholesaleUnitPrice,
      msrp: money(p.msrp),
      unitsPerCase: row.unitsPerCase,
      totalThc: row.totalThc,
      totalCbd: row.totalCbd,
      totalCannabinoidUnit: row.totalCannabinoidUnit,
      quantityActive: row.quantityActive,
      quantityActivePassedTesting: row.quantityActivePassedTesting,
      quantityAvailable: row.quantityAvailable,
      quantityIncoming: row.quantityIncoming,
      quantityReserved: row.quantityReserved,
      quantityPendingOutput: '0',
      quantityAvailableThresholdMin: row.quantityAvailableThresholdMin,
      quantityAvailableThresholdMax: row.quantityAvailableThresholdMax,
      unitNetWeight: null,
      unitServingSize: null,
      unitNetWeightAndServingSizeUnitType: null,
      grossWeight: null,
      grossWeightUnitType: null,
      menuVisibility: p.menu_visibility ?? 'INCLUDE_IN_ALL',
      menus: [...this.s.menus.values()].filter((m) => isOnMenu(p, m.id)).map((m) => ({ id: mid('menu', m.id), name: m.name })),
      thumbnailImageUrl: `${APP}/images/placeholder-product.png`,
      url: `${APP}/products/${p.id}`,
      insertedAt: p.inserted_datetime,
      updatedAt: p.updated_datetime,
      category: row.category,
      subcategory: null,
      group: null,
      unitType: EACH,
      strain: row.strain,
      brand: null,
      vendor: row.vendor,
      owner: null,
      quickbooksSalesItem: null,
      quickbooksPurchaseItem: null,
    };
    if (inc.images) out.images = [];
    if (inc.tags) out.tags = [];
    if (inc.byLocation) out.activeQuantitiesByLocation = row.activeQuantitiesByLocation;
    if (inc.costItems) out.activeQuantityCostItems = q.active > 0 ? [{ quantity: fmtNum(q.active), totalCost: money(q.cost), costType: 'PURCHASE' }] : null;
    if (inc.bom) out.billOfMaterials = null;
    return out;
  }

  // ── purchase orders ──────────────────────────────────────────────────────────────────────────

  purchaseOrder(p: PurchaseRec, inc: { items?: boolean; charges?: boolean; payments?: boolean } = {}) {
    const api = this.ser.purchase(p);
    const sub = p.items.reduce((a, i) => a + i.quantity * i.price, 0);
    const out: Record<string, unknown> = {
      id: mid('purchaseOrder', p.id),
      customFields: this.customFields('purchase', p.custom_data),
      purchaseNumber: p.purchase_number,
      status: p.status,
      color: null,
      paymentStatus: p.status === 'COMPLETED' ? 'PAID' : 'NOT_PAID',
      total: api.total,
      totalCharges: money(p.charges.reduce((a, c) => a + this.ser.chargeAmount(c, sub), 0)),
      paid: api.paid,
      orderDate: p.order_datetime,
      dueDate: p.due_datetime,
      createdDate: p.inserted_datetime,
      updatedDate: p.updated_datetime,
      description: p.description,
      url: `${APP}/purchase-orders/${p.id}`,
      supplier: this.companyRef(p.company_id),
      owner: this.userRef(p.owner_id),
      intakeLocation: this.locationRef(p.location_id),
      billingLocation: this.locationRef(p.billing_location_id),
      supplierLocation: this.locationRef(p.supplier_location_id),
      qbBillId: null,
      qbSyncStatus: p.status === 'DRAFT' ? null : 'NOT_SYNCED',
      complianceManifestNumber: p.metrc_transfer_id ? String(1_200_000 + (p.metrc_transfer_id % 100_000)).padStart(10, '0') : null,
    };
    if (inc.items) {
      out.orderItems = p.items.map((i) => {
        const pid = i.product_id ?? (i.batch_id ? this.s.batches.get(i.batch_id)?.product_id : null) ?? null;
        const prod = pid ? this.s.products.get(pid) : undefined;
        const b = i.batch_id ? this.s.batches.get(i.batch_id) : undefined;
        const lot = i.package_id ? this.s.lots.get(i.package_id) : undefined;
        return {
          id: mid('purchaseOrderItem', i.id),
          quantity: fmtNum(i.quantity),
          receivedQuantity: fmtNum(i.received_quantity),
          price: money(i.price),
          product: prod ? { id: mid('product', prod.id), name: prod.name, unitType: EACH } : null,
          batch: b ? { id: mid('batch', b.id), name: b.batch_number } : null,
          location: this.locationRef(i.location_id, false),
          package: lot?.compliance_label ? { id: mid('package', lot.id), metrcLabel: lot.compliance_label } : null,
        };
      });
    }
    if (inc.charges) {
      out.orderCharges = p.charges.map((c) => {
        const ch = this.ser.charge(c, sub);
        return { id: mid('charge', c.id), name: c.name, type: c.type, unitType: c.unit_type, percent: ch.percent ?? null, price: ch.price, isTax: false };
      });
    }
    if (inc.payments) out.payments = [];
    return out;
  }

  purchaseOrderRow(p: PurchaseRec) {
    const full = this.purchaseOrder(p);
    delete full.description;
    delete full.paid;
    delete full.billingLocation;
    delete full.supplierLocation;
    return full;
  }

  // ── sales orders ─────────────────────────────────────────────────────────────────────────────

  salesOrder(o: OrderRec, inc: { invoices?: boolean; items?: boolean; charges?: boolean; originals?: boolean } = {}) {
    const total = this.ser.orderTotal(o);
    const sub = o.items.reduce((a, i) => a + i.quantity * i.price, 0);
    const cost = o.items.reduce((a, i) => a + i.quantity * ((i.batch_id ? this.s.batches.get(i.batch_id)?.unit_cost : undefined) ?? this.s.products.get(i.product_id)?.unit_cost ?? 0), 0);
    const loc = this.s.locations.get(o.location_id);
    const out: Record<string, unknown> = {
      id: mid('salesOrder', o.id),
      customFields: this.customFields('order', {}),
      orderNumber: o.order_number,
      status: o.status,
      color: null,
      total: money(total),
      totalCharges: money(total - sub),
      totalReturned: '0.00',
      orderDate: o.order_datetime,
      dueDate: o.due_datetime,
      deliveryDate: o.delivery_datetime,
      createdDate: o.inserted_datetime,
      updatedDate: o.updated_datetime,
      externalNotes: o.external_notes,
      internalNotes: o.internal_notes,
      url: `${APP}/orders/${o.id}`,
      cost: money(cost),
      revenue: money(sub),
      customer: this.companyRef(o.company_id),
      owner: null,
      location: this.locationRef(o.location_id),
      shippingLocation: this.locationRef(o.shipping_location_id),
      billingLocation: this.locationRef(o.billing_location_id),
      menu: null,
      license: loc ? { id: mid('license', loc.license_id), licenseNumber: this.s.licenses.get(loc.license_id)?.license_number ?? null } : null,
      combinedOrder: null,
      complianceManifestNumber: null,
    };
    if (inc.originals) out.originalOrders = [];
    if (inc.invoices) out.invoices = [];
    if (inc.items) {
      out.orderItems = o.items.map((i) => {
        const prod = this.s.products.get(i.product_id);
        const b = i.batch_id ? this.s.batches.get(i.batch_id) : undefined;
        return {
          id: mid('salesOrderItem', i.id),
          lineGroup: i.id,
          quantity: fmtNum(i.quantity),
          price: money(i.price),
          priceBase: money(i.price_base),
          isSample: i.is_sample,
          note: i.note,
          product: prod ? { id: mid('product', prod.id), name: prod.name, sku: prod.sku, unitType: EACH } : null,
          batch: b ? { id: mid('batch', b.id), name: b.batch_number } : null,
          package: null,
          location: this.locationRef(i.location_id, false),
        };
      });
    }
    if (inc.charges) {
      out.orderCharges = o.charges.map((c) => {
        const ch = this.ser.charge(c, sub);
        return { id: mid('charge', c.id), name: c.name, type: c.type, unitType: c.unit_type, percent: ch.percent ?? null, price: ch.price, isTax: false };
      });
    }
    return out;
  }

  salesOrderRow(o: OrderRec) {
    const full = this.salesOrder(o);
    for (const k of ['externalNotes', 'internalNotes', 'cost', 'revenue', 'shippingLocation', 'billingLocation', 'menu', 'license', 'combinedOrder']) delete full[k];
    return full;
  }

  // ── companies ────────────────────────────────────────────────────────────────────────────────

  company(c: CompanyRec | 'self') {
    if (c === 'self') {
      return {
        id: mid('company', this.s.selfCompanyId),
        name: this.s.selfCompanyName,
        isMyCompany: true,
        customFields: this.customFields('company', {}),
        legalBusinessName: SELF_COMPANY.legal_business_name,
        category: 'Distributor',
        creditBalance: '0.00',
        outstandingBalance: '0.00',
        pastDueBalance: '0.00',
        outstandingBalanceThreshold: null,
        invoiceEmail: null,
        defaultPaymentTerm: null,
        owner: null,
        defaultInventoryLocation: this.locationRef(this.s.ownLocationIds[0] ?? null),
        lastOrderDate: null,
        relationshipType: null,
        group: null,
        email: 'ops@goldencoastdistro.com',
        phone: null,
        website: null,
        qbCustomerId: null,
        qbCustomer: null,
        qbVendorId: null,
        qbVendor: null,
        leaflinkBrandId: null,
        leaflinkCustomerId: null,
      };
    }
    const api = this.ser.company(c);
    let last: string | null = null;
    for (const o of this.s.orders.values()) if (o.company_id === c.id && o.status !== 'CANCELED' && (!last || o.order_datetime > last)) last = o.order_datetime;
    return {
      id: mid('company', c.id),
      name: c.name,
      isMyCompany: false,
      customFields: this.customFields('company', {}),
      legalBusinessName: c.legal_business_name,
      category: c.category,
      creditBalance: '0.00',
      outstandingBalance: api.outstanding_balance,
      pastDueBalance: api.past_due_balance,
      outstandingBalanceThreshold: null,
      invoiceEmail: api.invoice_email,
      defaultPaymentTerm: { id: 'pt_net30', name: 'Net 30' },
      owner: null,
      defaultInventoryLocation: null,
      lastOrderDate: last,
      relationshipType: { id: `rel-${c.relationship.toLowerCase()}`, name: c.relationship },
      group: null,
      email: c.default_email,
      phone: c.phone_number,
      website: c.website,
      qbCustomerId: null,
      qbCustomer: null,
      qbVendorId: null,
      qbVendor: null,
      leaflinkBrandId: null,
      leaflinkCustomerId: null,
    };
  }

  companyFull(c: CompanyRec | 'self', inc: { contacts?: boolean; locations?: boolean; licenses?: boolean }) {
    const base: Record<string, unknown> = { ...this.company(c) };
    const rec = c === 'self' ? null : c;
    base.usState = 'CA';
    base.description = null;
    base.defaultSalesOrderNotes = null;
    base.defaultPurchaseOrderNotes = rec?.default_purchase_order_notes ?? null;
    base.salesOrderEmail = rec?.relationship === 'Customer' ? rec.default_email : null;
    base.orderShipmentEmail = null;
    base.purchaseOrderEmail = rec?.relationship === 'Vendor' ? rec.default_email : null;
    const locIds = rec ? rec.location_ids : this.s.ownLocationIds;
    const licIds = rec ? rec.license_ids : this.s.ownLocationIds.map((id) => this.s.locations.get(id)!.license_id);
    if (inc.contacts) base.contacts = rec ? [{ id: `con_${rec.id.slice(0, 8)}`, profile: { fullName: `${rec.name} Orders` }, email: rec.default_email, phone: rec.phone_number }] : [];
    if (inc.locations) base.locations = locIds.map((id) => this.locationRef(id)!);
    if (inc.licenses) {
      base.licenses = licIds.map((id) => {
        const l = this.s.licenses.get(id)!;
        return { id: mid('license', l.id), licenseNumber: l.license_number, licenseType: l.license_type, expirationDate: l.expiry_datetime.slice(0, 10), isActive: l.active };
      });
    }
    return base;
  }

  // ── packages + test results ──────────────────────────────────────────────────────────────────

  private labState(lot: LotRec): { state: 'FAILED' | 'NOT_TESTED' | 'PASSED' | 'PENDING'; test: TestResultRec | undefined } {
    const t = lot.batch_id ? [...this.s.testResults.values()].find((x) => x.batch_id === lot.batch_id) : undefined;
    return { state: t ? (t.passed ? 'PASSED' : 'FAILED') : 'NOT_TESTED', test: t };
  }

  packageRow(lot: LotRec) {
    const s = this.s;
    const p = s.products.get(lot.product_id)!;
    const b = lot.batch_id ? s.batches.get(lot.batch_id) : undefined;
    const loc = s.locations.get(lot.location_id)!;
    const lic = s.licenses.get(loc.license_id)!;
    const { state, test } = this.labState(lot);
    const status = this.ser.package(lot).distru_status;
    const unitCost = b?.unit_cost ?? p.unit_cost;
    return {
      id: mid('package', lot.id),
      customFields: this.customFields('package', {}),
      metrcLabel: lot.compliance_label ?? '',
      complianceType: lot.metrc_id ? 'METRC' : 'NONE',
      metrcId: lot.metrc_id,
      complianceProductName: lot.metrc_id ? p.name : null,
      complianceStrainName: p.strain?.name ?? null,
      distruStatus: status === 'ONHOLD' ? 'ON_HOLD' : status,
      isActive: true,
      syncing: false,
      batchNumber: b?.batch_number ?? null,
      compliancePackagedDate: b ? b.manufactured_datetime.slice(0, 10) : null,
      harvestDate: b?.harvest_datetime ? b.harvest_datetime.slice(0, 10) : null,
      expirationDate: b?.expiration_datetime ? b.expiration_datetime.slice(0, 10) : null,
      finishedAt: lot.quantity > 0 ? null : lot.updated_datetime,
      insertedAt: lot.inserted_datetime,
      updatedAt: lot.updated_datetime,
      isTestSample: false,
      isTradeSample: false,
      isFinishedGood: lot.metrc_id ? true : null,
      labTestingState: state,
      labTestingStateDate: test?.release_date ?? null,
      quantity: fmtNum(lot.quantity),
      quantityActive: fmtNum(lot.on_hold ? 0 : lot.quantity),
      quantityAssembling: '0',
      quantityInMetrc: lot.metrc_id ? fmtNum(lot.quantity) : null,
      quantityCost: money(unitCost * lot.quantity),
      unitType: EACH,
      product: { id: mid('product', p.id), name: p.name, sku: p.sku, inventoryTrackingMethod: p.tracking },
      batch: b ? { id: mid('batch', b.id), name: b.batch_number } : null,
      location: this.locationRef(lot.location_id, false),
      license: { id: mid('license', lic.id), licenseNumber: lic.license_number },
      activeSalesOrder: null,
      primaryTestResult: test
        ? { id: mid('testResult', test.id), name: test.name, thcPercentageTotal: fmtNum(test.total_thc_percentage), cbdPercentageTotal: fmtNum(test.total_cbd_percentage) }
        : null,
    };
  }

  packageFull(lot: LotRec, inc: { costItems?: boolean } = {}) {
    const row: Record<string, unknown> = { ...this.packageRow(lot) };
    const b = lot.batch_id ? this.s.batches.get(lot.batch_id) : undefined;
    row.metrcStatus = lot.metrc_id ? (lot.on_hold ? 'ONHOLD' : lot.quantity > 0 ? 'ACTIVE' : 'FINISHED') : null;
    row.metrcProductionBatchNumber = b?.batch_number ?? null;
    row.metrcSourcePackageLabels = null;
    row.syncingReason = null;
    row.description = lot.on_hold ? 'Placed on hold: failed lab test' : null;
    if (inc.costItems) row.quantityCostItems = [{ quantity: row.quantity, totalCost: row.quantityCost, costType: 'PURCHASE' }];
    return row;
  }

  testResultRow(t: TestResultRec) {
    const lot = t.package_id ? this.s.lots.get(t.package_id) : undefined;
    const b = this.s.batches.get(t.batch_id);
    return {
      id: mid('testResult', t.id),
      name: t.name,
      labName: t.lab_name,
      releaseDate: t.release_date,
      thcPercentage: fmtNum(t.thc_percentage),
      thcPercentageTotal: fmtNum(t.total_thc_percentage),
      cbdPercentage: fmtNum(t.cbd_percentage),
      cbdPercentageTotal: fmtNum(t.total_cbd_percentage),
      batch: b ? { id: mid('batch', b.id), name: b.batch_number } : null,
      package: lot?.compliance_label ? { id: mid('package', lot.id), metrcLabel: lot.compliance_label } : null,
    };
  }

  // ── tasks + users ────────────────────────────────────────────────────────────────────────────

  task(t: TaskRec) {
    const s = this.s;
    const link = t.link;
    const pick = <T>(kind: string, f: () => T): T | null => (link?.kind === kind ? f() : null);
    const RELATED: Record<string, string> = { order: 'SALES_ORDER', purchase: 'PURCHASE_ORDER', product: 'PRODUCT', batch: 'BATCH', company: 'COMPANY', invoice: 'INVOICE', contact: 'CONTACT', assembly: 'ASSEMBLY', return: 'RETURN' };
    return {
      id: mid('task', t.id),
      name: t.name,
      description: t.description,
      status: t.status,
      dueDate: t.due_datetime,
      color: colorName(t.color),
      insertedAt: t.inserted_datetime,
      updatedAt: t.updated_datetime,
      relatedType: link ? (RELATED[link.kind] ?? null) : null,
      company: pick('company', () => this.companyRef(link!.id)),
      salesOrder: pick('order', () => {
        const o = s.orders.get(link!.id);
        return o ? { id: mid('salesOrder', o.id), orderNumber: o.order_number } : null;
      }),
      purchaseOrder: pick('purchase', () => {
        const p = s.purchases.get(link!.id);
        return p ? { id: mid('purchaseOrder', p.id), purchaseNumber: p.purchase_number } : null;
      }),
      invoice: null,
      product: pick('product', () => {
        const p = s.products.get(link!.id);
        return p ? { id: mid('product', p.id), name: p.name, sku: p.sku } : null;
      }),
      batch: pick('batch', () => {
        const b = s.batches.get(link!.id);
        return b ? { id: mid('batch', b.id), name: b.batch_number } : null;
      }),
      contact: null,
      assembly: null,
      return: null,
      owner: this.userRef(t.owner_id),
      creator: this.userRef(t.creator_id),
      location: this.locationRef(t.location_id, false),
      customFields: this.customFields('task', t.custom_data),
    };
  }

  user(u: UserRec) {
    return { id: mid('user', u.id), email: u.email, profile: { fullName: u.full_name } };
  }

  stockAdjustment(a: StockAdjustmentRec) {
    const s = this.s;
    const p = s.products.get(a.product_id)!;
    const lot = a.package_id ? s.lots.get(a.package_id) : undefined;
    const b = a.batch_id ? s.batches.get(a.batch_id) : undefined;
    const productTotal = s.quantityActive(p.id);
    const batchTotal = b ? [...s.lots.values()].filter((l) => l.batch_id === b.id).reduce((n, l) => n + l.quantity, 0) : 0;
    return {
      id: mid('stockAdjustment', a.id),
      quantity: fmtNum(a.quantity),
      adjustedDatetime: a.adjusted_datetime,
      location: this.locationRef(a.location_id, false),
      ...(lot ? { package: { id: mid('package', lot.id), metrcLabel: lot.compliance_label ?? '', quantity: fmtNum(lot.quantity) } } : {}),
      ...(b && !lot ? { batch: { id: mid('batch', b.id), name: b.batch_number, quantity: fmtNum(batchTotal) } } : {}),
      product: { id: mid('product', p.id), name: p.name, quantity: fmtNum(productTotal) },
      complianceActivity: a.compliance_activity ? { id: a.compliance_activity.id, system: a.compliance_activity.system, status: a.compliance_activity.status, error: a.compliance_activity.error } : null,
    };
  }

  // ── DistruCommerce menus ─────────────────────────────────────────────────────────────────────

  private menuUrl(m: MenuRec) {
    return `https://commerce.distru.com/menu/golden-coast-distribution/${m.url_suffix}`;
  }

  /** A menu is discoverable (listed to buyers in DistruCommerce) while active and PUBLIC. */
  private discoverable(m: MenuRec) {
    return m.active && m.visibility === 'PUBLIC';
  }

  menuRow(m: MenuRec) {
    return {
      id: mid('menu', m.id),
      name: m.name,
      externalName: m.external_name,
      menuTitle: m.external_name,
      active: m.active,
      discoverable: this.discoverable(m),
      visibility: m.visibility,
      primaryUrl: this.menuUrl(m),
      sellByCaseOnly: m.sell_by_case_only,
      showInventoryLevels: m.show_inventory_levels,
      allowSellingByPotency: m.allow_selling_by_potency,
      minimumOrderLeadTimeDays: m.minimum_order_lead_time_days,
      minimumOrderSubtotal: m.minimum_order_subtotal == null ? null : money(m.minimum_order_subtotal),
      aiOrderIntakeEmail: null,
      insertedAt: m.inserted_datetime,
      updatedAt: m.updated_datetime,
    };
  }

  private userName(id: string | null) {
    const u = id ? this.s.users.get(id) : undefined;
    return u ? { id: mid('user', u.id), fullName: u.full_name } : null;
  }

  menuCollection(c: MenuCollectionRec) {
    const s = this.s;
    return {
      id: mid('menuCollection', c.id),
      name: c.name,
      isHidden: c.is_hidden,
      onlyFeaturedProducts: c.only_featured_products,
      officialProductCategoryIds: c.official_product_category_ids,
      productCategories: c.product_category_ids.map((id) => ({ id: mid('category', id), name: s.categories.get(id)?.name ?? '' })),
      productSubcategories: [],
      productGroups: [],
      brands: [],
      strains: c.strain_ids.map((id) => ({ id, name: [...s.products.values()].find((p) => p.strain?.id === id)?.strain?.name ?? '' })),
      strainTypes: c.strain_types,
      thcRange: c.thc_range ? { ...(c.thc_range.min !== undefined ? { min: c.thc_range.min } : {}), ...(c.thc_range.max !== undefined ? { max: c.thc_range.max } : {}), unit: c.thc_range.unit } : null,
    };
  }

  menuSettings(m: MenuRec, inc: { collections?: boolean } = {}) {
    const out: Record<string, unknown> = {
      id: mid('menu', m.id),
      name: m.name,
      externalName: m.external_name,
      primaryUrl: this.menuUrl(m),
      owner: this.userName(m.owner_id),
      active: m.active,
      visibility: m.visibility,
      discoverable: this.discoverable(m),
      allowPartnerOrders: m.allow_partner_orders,
      locations: m.location_ids.map((id) => this.locationRef(id, false)!),
      minimumOrderSubtotal: m.minimum_order_subtotal == null ? null : money(m.minimum_order_subtotal),
      minimumOrderLeadTimeDays: m.minimum_order_lead_time_days,
      availableDeliveryDays: m.available_delivery_days,
      buyerCanSelectDeliveryDate: m.buyer_can_select_delivery_date,
      sellByCaseOnly: m.sell_by_case_only,
      allowCustomersToOverOrder: m.allow_customers_to_over_order,
      defaultOrderStatus: m.default_order_status,
      buyerDefaultOrderOwnerMode: m.buyer_default_order_owner_mode,
      buyerDefaultOrderOwner: this.userName(m.buyer_default_order_owner_id),
      sellerDefaultOrderOwnerMode: m.seller_default_order_owner_mode,
      sellerDefaultOrderOwner: this.userName(m.seller_default_order_owner_id),
      allowSalesRepsToOverrideNetTerms: m.allow_sales_reps_to_override_net_terms,
      autoCreateInvoiceForSalesRepOrders: m.auto_create_invoice_for_sales_rep_orders,
      showInventoryLevels: m.show_inventory_levels,
      showProductsWithNoInventoryMode: m.show_products_with_no_inventory_mode,
      hidePricesMode: m.hide_prices_mode,
      hideOriginalPriceWhenPriceTierApplied: m.hide_original_price_when_price_tier_applied,
      allowSellingByPotency: m.allow_selling_by_potency,
      potencyOfficialProductCategoryIds: m.potency_official_product_category_ids,
      showCoa: m.show_coa,
      showExpirationDate: m.show_expiration_date,
      showPackageDate: m.show_package_date,
      showTac: m.show_tac,
      showTotalCbd: m.show_total_cbd,
      allowBuyersToRequestTradeSamples: m.allow_buyers_to_request_trade_samples,
      restrictTradeSampleRequestToProductsInCart: m.restrict_trade_sample_request_to_products_in_cart,
      sendInternalOrderNotifications: m.send_internal_order_notifications,
      internalOrderNotificationRecipients: m.internal_order_notification_recipient_ids.map((id) => this.userName(id)).filter(Boolean),
    };
    if (inc.collections) {
      out.collections = m.collections.slice(0, 120).map((c) => this.menuCollection(c));
      out.officialCollections = OFFICIAL_COLLECTIONS.map((name) => ({ officialCollectionName: name, customName: m.official_collection_names[name] ?? null }));
    }
    return out;
  }

  /** A product as a menu shows it to buyers. */
  menuProduct(m: MenuRec, p: ProductRec) {
    const s = this.s;
    const cat = s.categories.get(p.category_id);
    const available = menuAvailable(s, m, p.id);
    const levels = new Map<string, number>();
    for (const l of s.lotsForProduct(p.id)) {
      if (!m.location_ids.includes(l.location_id) || l.quantity <= 0 || l.on_hold) continue;
      const thc = l.batch_id ? s.batches.get(l.batch_id)?.thc : null;
      if (thc == null) continue;
      levels.set(fmtNum(thc, 1), (levels.get(fmtNum(thc, 1)) ?? 0) + l.quantity);
    }
    const thcs = [...levels.keys()].map(Number).sort((a, b) => a - b);
    const show = m.show_inventory_levels;
    return {
      id: mid('product', p.id),
      name: p.external_name || p.name,
      unitsPerCase: p.units_per_case == null ? null : String(p.units_per_case),
      maxMenuBuyerOrderQuantity: p.max_menu_buyer_order_quantity ?? null,
      totalThc: p.total_thc == null ? null : fmtNum(p.total_thc),
      totalCannabinoidUnit: p.cannabinoid_unit,
      brand: null,
      category: { id: mid('category', p.category_id), name: cat?.name ?? '', officialProductCategory: { id: officialCategoryOf(s, p) } },
      subcategory: null,
      strain: p.strain ? { id: p.strain.id, name: p.strain.name, strainType: p.strain.strain_type } : null,
      unitType: { id: EACH.id, name: EACH.name, category: 'COUNT', qtyPerSiUnit: null },
      quantityAvailable: show ? fmtNum(Math.max(0, available)) : null,
      soldOut: available <= 0,
      unitPrice: m.hide_prices_mode === 'HIDE_FOR_EVERYONE' ? null : money(p.unit_price),
      thcPercentageTotalLevels: [...levels].map(([thc, q]) => ({ thcPercentageTotal: thc, quantityAvailable: show ? fmtNum(q) : null })),
      thcPercentageTotalRange: thcs.length ? { min: fmtNum(thcs[0]!), max: fmtNum(thcs.at(-1)!) } : null,
    };
  }

  /** Products a collection picks from what the menu shows. */
  collectionProducts(m: MenuRec, c: { official?: string; rec?: MenuCollectionRec }): ProductRec[] {
    const s = this.s;
    const all = menuProducts(s, m);
    if (c.official) {
      if (c.official === 'All Products') return all;
      if (c.official === 'Recently Ordered') return [];
      return all.filter((p) => OFFICIAL_NAMES[officialCategoryOf(s, p)] === c.official);
    }
    const r = c.rec!;
    return all.filter((p) => {
      if (r.only_featured_products && !p.is_featured) return false;
      if (r.official_product_category_ids.length && !r.official_product_category_ids.includes(officialCategoryOf(s, p))) return false;
      if (r.product_category_ids.length && !r.product_category_ids.includes(p.category_id)) return false;
      if (r.strain_ids.length && (!p.strain || !r.strain_ids.includes(p.strain.id))) return false;
      if (r.strain_types.length && (!p.strain || !r.strain_types.includes(p.strain.strain_type))) return false;
      if (r.thc_range && r.thc_range.unit === (p.cannabinoid_unit ?? 'PERCENT')) {
        const thc = p.total_thc;
        if (thc == null) return false;
        if (r.thc_range.min !== undefined && thc < Number(r.thc_range.min)) return false;
        if (r.thc_range.max !== undefined && thc > Number(r.thc_range.max)) return false;
      }
      return true;
    });
  }

  // ── history ──────────────────────────────────────────────────────────────────────────────────

  private actor(id: string | null) {
    const u = id ? this.s.users.get(id) : undefined;
    return u ? { id: mid('user', u.id), name: u.full_name } : null;
  }

  private rows(rows: { entity: string; entity_label: string; op: string; row_id: string | null; row_label: string | null; fields: { field: string; label: string; old_value: unknown; new_value: unknown }[] }[]) {
    return rows.map((r) => ({
      entity: r.entity,
      entityLabel: r.entity_label,
      op: r.op,
      rowId: r.row_id,
      rowLabel: r.row_label,
      fields: r.fields.map((f) => ({ field: f.field, label: f.label, oldValue: f.old_value, newValue: f.new_value })),
    }));
  }

  historyChange(a: ActivityRec, recordType: string, recordId: string) {
    const rows = a.records.filter((r) => r.type === recordType && r.id === recordId).flatMap((r) => r.rows);
    return {
      type: 'CHANGE' as const,
      id: mid('activity', a.id),
      changedAt: a.changed_datetime,
      actor: this.actor(a.actor_id),
      impersonator: null,
      source: a.source,
      sourceDetail: a.source_detail,
      rowCount: rows.length,
      truncated: false,
      rows: this.rows(rows),
      events: [],
    };
  }

  activity(a: ActivityRec, recordTypes?: string[]) {
    const rest = serializeActivity(this.s, a, recordTypes);
    return {
      id: mid('activity', a.id),
      changedAt: a.changed_datetime,
      actor: this.actor(a.actor_id),
      impersonator: null,
      source: a.source,
      sourceDetail: a.source_detail,
      rowCount: rest.row_count,
      truncated: rest.truncated,
      recordCounts: rest.record_counts,
      records: rest.records.map((r) => ({
        type: r.type,
        id: r.id ? mcpRecordId(r.type, r.id) : null,
        name: r.name,
        rowCount: r.row_count,
        truncated: r.truncated,
        // the activity feed names the changed fields, not their values
        rows: r.rows.map((row) => ({ entity: row.entity, entityLabel: row.entity_label, op: row.op, rowId: row.row_id, rowLabel: row.row_label, fields: row.fields.map((f) => f.field) })),
        events: [],
      })),
    };
  }
}

/** Prefixed id for a history record of a REST record-history type. */
export function mcpRecordId(type: string | null, id: string): string {
  switch (type) {
    case 'PURCHASE':
      return mid('purchaseOrder', id);
    case 'SALES_ORDER':
      return mid('salesOrder', id);
    case 'PRODUCT':
      return mid('product', id);
    case 'BATCH':
      return mid('batch', id);
    case 'PACKAGE':
      return mid('package', id);
    case 'COMPANY':
      return mid('company', id);
    case 'USER':
      return mid('user', id);
    case 'TEST_RESULT':
      return mid('testResult', id);
    case 'MENU':
      return mid('menu', id);
    default:
      return toMcpId('task', id) ?? id;
  }
}
