/**
 * Products and stores the mock knows about.
 *
 * Mirrors `apps/distru-mock/src/seed.ts` (same SKUs, product names, brands and the six dispensary
 * customers), replicated here because that seed does not export its catalog. `test/catalog.test.ts`
 * fails if the two drift apart. `demand` is the distributor's mean wholesale units/day for the SKU,
 * used to size plausible retail volumes; `retail` is a typical shelf price.
 */
export type Category = 'Flower' | 'Pre-Rolls' | 'Vapes' | 'Edibles' | 'Concentrates' | 'Accessories';

export interface CatalogItem {
  sku: string;
  name: string;
  brand: string;
  category: Category;
  /** distributor wholesale price (distru-mock `price`) */
  wholesale: number;
  /** mean wholesale units/day across the distributor's customers */
  demand: number;
}

const HHF = 'Humboldt Heritage Farms';
const ETG = 'Emerald Triangle Growers';
const SEC = 'Sierra Extracts Co.';
const GSE = 'Golden State Edibles';
const CCV = 'Coastal Cloud Vapes';
const MPR = 'Mojave Pre-Roll Co.';

// prettier-ignore
export const CATALOG: readonly CatalogItem[] = [
  { sku: 'FLW-BD-35', name: 'Blue Dream 3.5g', brand: HHF, category: 'Flower', wholesale: 25, demand: 9 },
  { sku: 'FLW-OGK-35', name: 'OG Kush 3.5g', brand: HHF, category: 'Flower', wholesale: 27, demand: 6 },
  { sku: 'FLW-GSC-35', name: 'Girl Scout Cookies 3.5g', brand: HHF, category: 'Flower', wholesale: 28, demand: 5 },
  { sku: 'FLW-SD-35', name: 'Sour Diesel 3.5g', brand: ETG, category: 'Flower', wholesale: 26, demand: 5 },
  { sku: 'FLW-GG4-35', name: 'Gorilla Glue #4 3.5g', brand: ETG, category: 'Flower', wholesale: 27, demand: 4 },
  { sku: 'FLW-WC-35', name: 'Wedding Cake 3.5g', brand: ETG, category: 'Flower', wholesale: 30, demand: 8 },
  { sku: 'FLW-GL-35', name: 'Gelato 3.5g', brand: HHF, category: 'Flower', wholesale: 30, demand: 4 },
  { sku: 'FLW-ZK-35', name: 'Zkittlez 3.5g', brand: ETG, category: 'Flower', wholesale: 28, demand: 3 },
  { sku: 'FLW-BD-28', name: 'Blue Dream Smalls 28g', brand: HHF, category: 'Flower', wholesale: 120, demand: 1.2 },
  { sku: 'FLW-PE-14', name: 'Purple Punch 14g', brand: ETG, category: 'Flower', wholesale: 80, demand: 1.5 },
  { sku: 'FLW-TW-35', name: 'Trainwreck 3.5g (Discontinued)', brand: HHF, category: 'Flower', wholesale: 24, demand: 2 },
  { sku: 'PRE-BD-1G', name: 'Blue Dream Pre-Roll 1g', brand: MPR, category: 'Pre-Rolls', wholesale: 9, demand: 14 },
  { sku: 'PRE-OGK-1G', name: 'OG Kush Pre-Roll 1g', brand: MPR, category: 'Pre-Rolls', wholesale: 9, demand: 8 },
  { sku: 'PRE-SD-5PK', name: 'Sour Diesel Mini Pre-Rolls 5-Pack', brand: MPR, category: 'Pre-Rolls', wholesale: 22, demand: 4 },
  { sku: 'PRE-HYB-5PK', name: 'House Hybrid Mini Pre-Rolls 5-Pack', brand: HHF, category: 'Pre-Rolls', wholesale: 18, demand: 5 },
  { sku: 'PRE-INF-1G', name: 'Gelato Infused Pre-Roll 1g', brand: MPR, category: 'Pre-Rolls', wholesale: 15, demand: 6 },
  { sku: 'PRE-JH-1G', name: 'Jack Herer Pre-Roll 1g', brand: MPR, category: 'Pre-Rolls', wholesale: 9, demand: 5 },
  { sku: 'PRE-GDP-1G', name: 'Granddaddy Purple Pre-Roll 1g', brand: MPR, category: 'Pre-Rolls', wholesale: 9, demand: 5 },
  { sku: 'PRE-IND-10PK', name: 'Indica Dogwalkers 10-Pack', brand: HHF, category: 'Pre-Rolls', wholesale: 30, demand: 2.5 },
  { sku: 'VAP-BD-1G', name: 'Blue Dream Live Resin Cart 1g', brand: SEC, category: 'Vapes', wholesale: 40, demand: 7 },
  { sku: 'VAP-PE-1G', name: 'Pineapple Express Cart 1g', brand: CCV, category: 'Vapes', wholesale: 35, demand: 6 },
  { sku: 'VAP-GSC-05', name: 'GSC Cart 0.5g', brand: CCV, category: 'Vapes', wholesale: 22, demand: 5 },
  { sku: 'VAP-MAN-AIO', name: 'Mango Haze All-in-One 0.5g', brand: CCV, category: 'Vapes', wholesale: 25, demand: 4 },
  { sku: 'VAP-WM-1G', name: 'Watermelon Distillate Cart 1g', brand: CCV, category: 'Vapes', wholesale: 32, demand: 4 },
  { sku: 'VAP-SD-LR', name: 'Sour Diesel Live Rosin Cart 0.5g', brand: SEC, category: 'Vapes', wholesale: 50, demand: 2.5 },
  { sku: 'VAP-NL-1G', name: 'Northern Lights Cart 1g', brand: SEC, category: 'Vapes', wholesale: 36, demand: 3.5 },
  { sku: 'VAP-CBD-11', name: '1:1 CBD Calm Cart 0.5g', brand: CCV, category: 'Vapes', wholesale: 28, demand: 2 },
  { sku: 'VAP-GDP-AIO', name: 'GDP Disposable 1g', brand: SEC, category: 'Vapes', wholesale: 38, demand: 3.5 },
  { sku: 'EDB-GUM-WM', name: 'Watermelon Gummies 100mg', brand: GSE, category: 'Edibles', wholesale: 18, demand: 10 },
  { sku: 'EDB-GUM-SB', name: 'Sour Blue Raspberry Gummies 100mg', brand: GSE, category: 'Edibles', wholesale: 18, demand: 6 },
  { sku: 'EDB-CHO-DK', name: 'Dark Chocolate Bar 100mg', brand: GSE, category: 'Edibles', wholesale: 20, demand: 6 },
  { sku: 'EDB-CHO-MS', name: 'Milk Chocolate Sea Salt 100mg', brand: GSE, category: 'Edibles', wholesale: 20, demand: 3 },
  { sku: 'EDB-MNT-PP', name: 'Peppermint Mints 100mg', brand: GSE, category: 'Edibles', wholesale: 16, demand: 3 },
  { sku: 'EDB-BEV-LEM', name: 'Sparkling Lemonade 10mg', brand: GSE, category: 'Edibles', wholesale: 8, demand: 5 },
  { sku: 'EDB-GUM-SLP', name: 'Sleep Gummies THC+CBN 100mg', brand: GSE, category: 'Edibles', wholesale: 22, demand: 4 },
  { sku: 'EDB-CKE-SNK', name: 'Snickerdoodle Cookie 50mg', brand: GSE, category: 'Edibles', wholesale: 10, demand: 2 },
  { sku: 'CON-LR-BD', name: 'Blue Dream Live Resin 1g', brand: SEC, category: 'Concentrates', wholesale: 38, demand: 5 },
  { sku: 'CON-SHT-GG', name: 'Gorilla Glue Shatter 1g', brand: SEC, category: 'Concentrates', wholesale: 25, demand: 3 },
  { sku: 'CON-BAD-WC', name: 'Wedding Cake Badder 1g', brand: SEC, category: 'Concentrates', wholesale: 34, demand: 3 },
  { sku: 'CON-RSN-GL', name: 'Gelato Live Rosin 1g', brand: SEC, category: 'Concentrates', wholesale: 55, demand: 2 },
  { sku: 'CON-DIA-SD', name: 'Sour Diesel Diamonds 1g', brand: SEC, category: 'Concentrates', wholesale: 42, demand: 2 },
  { sku: 'ACC-BAT-BLK', name: '510 Thread Battery - Black', brand: CCV, category: 'Accessories', wholesale: 12, demand: 3 },
  { sku: 'ACC-BAT-SLV', name: '510 Thread Battery - Silver', brand: CCV, category: 'Accessories', wholesale: 12, demand: 1.5 },
];

export interface Store {
  id: string;
  name: string;
  city: string;
  state: 'CA';
  /** true for the six dispensaries that buy from the distributor in distru-mock */
  distributor_customer: boolean;
  /** relative store size (multiplies retail volume) */
  size: number;
}

// prettier-ignore
export const STORES: readonly Store[] = [
  { id: 'st_green_leaf_oak', name: 'Green Leaf Dispensary', city: 'Oakland', state: 'CA', distributor_customer: true, size: 1.2 },
  { id: 'st_sunset_sf', name: 'Sunset Cannabis Collective', city: 'San Francisco', state: 'CA', distributor_customer: true, size: 1.0 },
  { id: 'st_elevate_la', name: 'Elevate Wellness', city: 'Los Angeles', state: 'CA', distributor_customer: true, size: 1.4 },
  { id: 'st_canopy_sac', name: 'Canopy Club Sacramento', city: 'Sacramento', state: 'CA', distributor_customer: true, size: 0.9 },
  { id: 'st_harbor_lb', name: 'Harbor Greens', city: 'Long Beach', state: 'CA', distributor_customer: true, size: 0.8 },
  { id: 'st_herbal_cure_sj', name: 'The Herbal Cure', city: 'San Jose', state: 'CA', distributor_customer: true, size: 1.0 },
  { id: 'st_mission_sf', name: 'Mission Street Provisions', city: 'San Francisco', state: 'CA', distributor_customer: false, size: 1.1 },
  { id: 'st_redwood_eureka', name: 'Redwood Remedies', city: 'Eureka', state: 'CA', distributor_customer: false, size: 0.6 },
  { id: 'st_coastline_sd', name: 'Coastline Cannabis Co.', city: 'San Diego', state: 'CA', distributor_customer: false, size: 1.3 },
  { id: 'st_valley_fresno', name: 'Valley Leaf Fresno', city: 'Fresno', state: 'CA', distributor_customer: false, size: 0.7 },
];

export const bySku = new Map(CATALOG.map((p) => [p.sku, p]));
export const byStoreId = new Map(STORES.map((s) => [s.id, s]));
