/**
 * DistruCommerce menus (docs/research/mcptools/{search-menus,get-menu-settings,search-menu-products,
 * search-menu-collections,mutate-menu,mutate-product}.md), on the same store as everything else.
 *
 * - A product is on a menu by its own placement (`menu_visibility`: INCLUDE_IN_ALL, or INCLUDE_IN_SELECT
 *   with `menu_ids`), as Distru does; menus don't list products themselves.
 * - Quantity available on a menu is live: active − reserved at the menu's inventory locations.
 * - The per-buyer cap is the product's `maxMenuBuyerOrderQuantity`: "most units of the product one buyer
 *   may put in one Distru Commerce menu order, on every menu; sales reps are exempt". It is set with
 *   distru-mutate-product (or bulk-update-products), not distru-mutate-menu.
 * - Menus can't be deleted (Distru: "can't do yet"); retire one with active false.
 */
import type { Rng, Store } from './store';
import type { MenuCollectionRec, MenuRec, OfficialCategory, ProductRec } from './types';

export const OFFICIAL_BY_CATEGORY: Record<string, OfficialCategory> = {
  Flower: 'FLOWER',
  'Pre-Rolls': 'PREROLLS',
  Vapes: 'VAPES',
  Edibles: 'EDIBLES',
  Concentrates: 'CONCENTRATES',
  Accessories: 'MERCH',
};
export const OFFICIAL_NAMES: Record<OfficialCategory, string> = {
  CAPSULES: 'Capsules',
  CLONES: 'Clones & Seeds',
  CONCENTRATES: 'Concentrates',
  EDIBLES: 'Edibles',
  FLOWER: 'Flower',
  MERCH: 'Merch',
  OTHER: 'Other',
  PREROLLS: 'Pre-Rolls',
  TINCTURES: 'Tincture',
  TOPICALS: 'Topicals',
  VAPES: 'Vapes',
};
export const OFFICIAL_COLLECTIONS = ['Recently Ordered', 'Capsules', 'Clones & Seeds', 'Concentrates', 'Edibles', 'Flower', 'Merch', 'Pre-Rolls', 'Tincture', 'Topicals', 'Vapes', 'Other', 'All Products'] as const;

export const officialCategoryOf = (s: Store, p: ProductRec): OfficialCategory => OFFICIAL_BY_CATEGORY[s.categories.get(p.category_id)?.name ?? ''] ?? 'OTHER';

export function isOnMenu(p: ProductRec, menuId: string): boolean {
  if (!p.is_active) return false;
  const v = p.menu_visibility ?? 'INCLUDE_IN_ALL';
  return v === 'INCLUDE_IN_ALL' || (v === 'INCLUDE_IN_SELECT' && (p.menu_ids ?? []).includes(menuId));
}

/** Live quantity a menu can sell: active − reserved at its inventory locations. */
export function menuAvailable(s: Store, menu: MenuRec, productId: string): number {
  return s.quantityActive(productId, menu.location_ids) - s.quantityReserved(productId, menu.location_ids);
}

/** Products buyers see on a menu (honours showProductsWithNoInventoryMode). */
export function menuProducts(s: Store, menu: MenuRec): ProductRec[] {
  return [...s.products.values()].filter((p) => isOnMenu(p, menu.id) && (menu.show_products_with_no_inventory_mode !== 'DO_NOT_SHOW' || menuAvailable(s, menu, p.id) > 0));
}

const slug = (v: string) =>
  v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export function defaultCollections(s: Store, now: string): MenuCollectionRec[] {
  const base = (name: string, extra: Partial<MenuCollectionRec>): MenuCollectionRec => ({
    id: s.newId(),
    name,
    is_hidden: false,
    only_featured_products: false,
    official_product_category_ids: [],
    product_category_ids: [],
    strain_ids: [],
    strain_types: [],
    thc_range: null,
    inserted_datetime: now,
    updated_datetime: now,
    ...extra,
  });
  const cats = [...new Set([...s.categories.values()].map((c) => OFFICIAL_BY_CATEGORY[c.name] ?? 'OTHER'))];
  return [base('Featured Products', { only_featured_products: true }), ...cats.map((c) => base(OFFICIAL_NAMES[c], { official_product_category_ids: [c] }))];
}

export function newMenu(s: Store, fields: Pick<MenuRec, 'name' | 'location_ids'> & Partial<MenuRec>, now = s.nowIso()): MenuRec {
  return {
    id: s.newId(),
    external_name: fields.name,
    url_suffix: slug(fields.name),
    owner_id: null,
    active: false,
    visibility: 'PUBLIC',
    passcode: null,
    allow_partner_orders: true,
    minimum_order_subtotal: null,
    minimum_order_lead_time_days: 1,
    available_delivery_days: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'],
    buyer_can_select_delivery_date: true,
    sell_by_case_only: true,
    allow_customers_to_over_order: false,
    default_order_status: 'Pending',
    buyer_default_order_owner_mode: 'DEFAULT',
    buyer_default_order_owner_id: null,
    seller_default_order_owner_mode: 'SALES_REP',
    seller_default_order_owner_id: null,
    allow_sales_reps_to_override_net_terms: false,
    auto_create_invoice_for_sales_rep_orders: false,
    show_inventory_levels: true,
    show_products_with_no_inventory_mode: 'SHOW_AS_SOLD_OUT',
    hide_prices_mode: 'DO_NOT_HIDE',
    hide_original_price_when_price_tier_applied: false,
    allow_selling_by_potency: false,
    potency_official_product_category_ids: [],
    show_coa: true,
    show_expiration_date: false,
    show_package_date: false,
    show_tac: false,
    show_total_cbd: false,
    allow_buyers_to_request_trade_samples: false,
    restrict_trade_sample_request_to_products_in_cart: false,
    send_internal_order_notifications: true,
    internal_order_notification_recipient_ids: s.apiUserId ? [s.apiUserId] : [],
    collections: defaultCollections(s, now),
    official_collection_names: {},
    inserted_datetime: now,
    updated_datetime: now,
    ...fields,
  };
}

/** Seed: a public wholesale menu for every dispensary and a private VIP menu with allocation-only SKUs. */
export const VIP_ONLY_SKUS = ['FLW-GL-35', 'CON-RSN-GL', 'CON-DIA-SD'];
export const CAPPED_SKU = { sku: 'CON-RSN-GL', max: 12 };

export function seedMenus(s: Store, r: Rng, created: string): void {
  s.newId = () => r.uuid(); // deterministic ids while seeding
  const sales = [...s.users.values()].find((u) => u.role.name === 'Sales Rep');
  const wholesale = newMenu(
    s,
    { name: 'California Wholesale', external_name: 'Golden Coast — California Wholesale', location_ids: [...s.ownLocationIds], active: true, visibility: 'PUBLIC', owner_id: sales?.id ?? null, minimum_order_subtotal: 500 },
    created,
  );
  const vip = newMenu(
    s,
    {
      name: 'VIP Reserve',
      external_name: 'Golden Coast VIP Reserve',
      url_suffix: 'vip-reserve',
      location_ids: [s.ownLocationIds[0]!],
      active: true,
      visibility: 'PRIVATE',
      owner_id: sales?.id ?? null,
      sell_by_case_only: false,
      show_coa: true,
      show_total_cbd: true,
      minimum_order_lead_time_days: 2,
    },
    created,
  );
  vip.collections.push({
    id: s.newId(),
    name: 'Limited allocation',
    is_hidden: false,
    only_featured_products: false,
    official_product_category_ids: ['FLOWER', 'CONCENTRATES'],
    product_category_ids: [],
    strain_ids: [],
    strain_types: [],
    thc_range: { min: '25', unit: 'PERCENT' },
    inserted_datetime: created,
    updated_datetime: created,
  });
  s.menus.set(wholesale.id, wholesale);
  s.menus.set(vip.id, vip);
  for (const p of s.products.values()) {
    if (VIP_ONLY_SKUS.includes(p.sku)) {
      p.menu_visibility = 'INCLUDE_IN_SELECT';
      p.menu_ids = [vip.id];
    }
    if (p.sku === CAPPED_SKU.sku) p.max_menu_buyer_order_quantity = CAPPED_SKU.max;
    if (p.sku === 'FLW-BD-35') p.is_featured = true;
  }
  s.newId = () => crypto.randomUUID();
}

export interface MenuOrderLine {
  product_id: string;
  quantity: number;
}

/**
 * Rules a buyer's menu order must meet: product on the menu, at most maxMenuBuyerOrderQuantity units
 * (sales reps are exempt), whole cases when sellByCaseOnly, within quantity available unless the menu
 * allows over-ordering. Returns REST-style errors (empty when the order is fine).
 */
export function menuOrderErrors(s: Store, menu: MenuRec, lines: MenuOrderLine[], placedBy: 'buyer' | 'sales_rep') {
  const errors: { message: string; pointer: (string | number)[] }[] = [];
  if (!menu.active) errors.push({ message: 'the menu is inactive and takes no orders', pointer: ['menu_id'] });
  lines.forEach((l, i) => {
    const p = s.products.get(l.product_id);
    if (!p || !isOnMenu(p, menu.id)) return errors.push({ message: 'is not on this menu', pointer: ['items', i, 'product_id'] });
    const cap = p.max_menu_buyer_order_quantity;
    if (placedBy === 'buyer' && cap != null && l.quantity > cap) {
      errors.push({ message: `exceeds the most units of ${p.name} one buyer may order (${cap})`, pointer: ['items', i, 'quantity'] });
    }
    if (menu.sell_by_case_only && p.units_per_case && l.quantity % p.units_per_case !== 0) {
      errors.push({ message: `must be whole cases of ${p.units_per_case}`, pointer: ['items', i, 'quantity'] });
    }
    if (!menu.allow_customers_to_over_order && l.quantity > menuAvailable(s, menu, p.id)) {
      errors.push({ message: `exceeds the quantity available on this menu (${Math.max(0, menuAvailable(s, menu, p.id))})`, pointer: ['items', i, 'quantity'] });
    }
  });
  return errors;
}
