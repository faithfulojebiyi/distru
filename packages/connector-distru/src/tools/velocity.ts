import type { GetInventoryVelocityReportParams, InventoryVelocityReportRow } from '@ops/distru-client';
import { defineReadTool } from '@ops/harness';
import { z } from 'zod';
import { label, locationNames, num, num0, RefSchema, reportDate, take, type DistruCtx } from '../shared';

/**
 * Distru has no default lead time: without `lead_time_days` no row gets a reorder point, and a
 * `below_reorder_point` filter (true OR false) then drops every row. An omitted lead time used to make
 * the tool return nothing; it now falls back to this.
 */
export const DEFAULT_LEAD_TIME_DAYS = 14;

export const VelocityReportInput = z.object({
  below_reorder_point: z
    .union([z.boolean(), z.literal('any')])
    .default(true)
    .describe("true (default): only SKUs at or below their reorder point. false: only SKUs above it. 'any': every SKU with sales, either way (use it to look up specific product_ids)."),
  lead_time_days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe(`Supplier lead time used for reorder points. Distru computes no reorder point without it, so ${DEFAULT_LEAD_TIME_DAYS} is used when omitted.`),
  target_days_of_supply: z.number().int().min(1).max(365).optional().describe('Days of stock a suggested order should cover.'),
  service_level: z.number().int().min(50).max(99).optional().describe('Safety-stock service level, percent.'),
  vendor_ids: z.array(z.string().min(1)).max(50).optional(),
  location_ids: z.array(z.string().min(1)).max(20).optional().describe('When given, the report is computed per location and rows are tagged with it.'),
  product_ids: z.array(z.string().min(1)).max(100).optional(),
  search: z.string().min(1).max(100).optional().describe('Name/SKU search.'),
  limit: z.number().int().min(1).max(200).default(50),
});

export const VelocityRowSchema = z.object({
  product_id: z.string(),
  sku: z.string(),
  name: z.string(),
  vendor: RefSchema,
  location: RefSchema.nullable().describe('null = all locations combined'),
  on_hand_available: z.number().describe('Active minus reserved units'),
  incoming: z.number().describe('Units on open purchase orders'),
  avg_daily_demand: z.number(),
  days_of_supply: z.number().nullable(),
  days_of_supply_with_incoming: z.number().nullable(),
  reorder_point: z.number().nullable(),
  reorder_status: z.string().describe('LATE | ORDER_NOW | ORDER_SOON | OK | NO_RECENT_SALES | UNKNOWN'),
  suggested_qty: z.number().nullable(),
  units_per_case: z.number().nullable(),
  estimated_stockout_date: z.string().nullable().describe('YYYY-MM-DD'),
  reorder_by_date: z.string().nullable().describe('YYYY-MM-DD'),
  confidence: z.string(),
});
export type VelocityRow = z.infer<typeof VelocityRowSchema>;

export const VelocityReportOutput = z.object({
  params: z.object({
    below_reorder_point: z.union([z.boolean(), z.literal('any')]),
    lead_time_days: z.number().nullable(),
    target_days_of_supply: z.number().nullable(),
    service_level: z.number().nullable(),
  }),
  count: z.number(),
  truncated: z.boolean(),
  rows: z.array(VelocityRowSchema),
});

const toRow = (r: InventoryVelocityReportRow, location: VelocityRow['location']): VelocityRow => ({
  product_id: r.product_id,
  sku: label(r.sku, 60),
  name: label(r.name),
  vendor: { id: r.vendor_id, name: label(r.vendor) },
  location,
  on_hand_available: num0(r.quantity_available),
  incoming: num0(r.quantity_incoming),
  avg_daily_demand: num0(r.average_daily_sold),
  days_of_supply: num(r.days_of_supply),
  days_of_supply_with_incoming: num(r.days_of_supply_with_incoming),
  reorder_point: num(r.reorder_point),
  reorder_status: r.reorder_status,
  suggested_qty: num(r.suggested_order_quantity),
  units_per_case: num(r.units_per_case),
  estimated_stockout_date: reportDate(r.estimated_stockout_date),
  reorder_by_date: reportDate(r.reorder_by_date),
  confidence: r.confidence,
});

export const velocityReportTool = defineReadTool({
  name: 'velocity_report',
  description:
    'Inventory velocity / reorder report: SKUs at risk of stocking out with days of supply, reorder point and a suggested order quantity. Use first to find what needs restocking. Pass lead_time_days (the vendor lead time, see the vendors tool); 14 is used when omitted, because Distru computes no reorder point without one.',
  input: VelocityReportInput,
  output: VelocityReportOutput,
  run: async (ctx: DistruCtx, input) => {
    const client = ctx.connectors.distru;
    const leadTime = input.lead_time_days ?? DEFAULT_LEAD_TIME_DAYS;
    const base: GetInventoryVelocityReportParams = {
      ...(input.below_reorder_point === 'any' ? {} : { below_reorder_point: input.below_reorder_point }),
      lead_time_days: leadTime,
      ...(input.target_days_of_supply !== undefined ? { target_days_of_supply: input.target_days_of_supply } : {}),
      ...(input.service_level !== undefined ? { service_level: input.service_level } : {}),
      ...(input.vendor_ids ? { vendor_ids: input.vendor_ids } : {}),
      ...(input.product_ids ? { product_ids: input.product_ids } : {}),
      ...(input.search ? { search: input.search } : {}),
    };
    let rows: VelocityRow[];
    if (input.location_ids?.length) {
      const names = await locationNames(client);
      const perLocation = await Promise.all(
        input.location_ids.map(async (id) => {
          const report = await client.getInventoryVelocityReport({ ...base, location_ids: [id] });
          return report.data.map((r) => toRow(r, { id, name: names.get(id) ?? id }));
        }),
      );
      rows = perLocation.flat();
    } else {
      rows = (await client.getInventoryVelocityReport(base)).data.map((r) => toRow(r, null));
    }
    rows.sort((a, b) => (a.days_of_supply ?? Infinity) - (b.days_of_supply ?? Infinity) || a.sku.localeCompare(b.sku));
    const { items, truncated } = take(rows, input.limit);
    return {
      params: {
        below_reorder_point: input.below_reorder_point,
        lead_time_days: leadTime,
        target_days_of_supply: input.target_days_of_supply ?? null,
        service_level: input.service_level ?? null,
      },
      count: rows.length,
      truncated,
      rows: items,
    };
  },
});
