import type { ConnectorContext } from '@ops/harness';
import { z } from 'zod';
import { createHeadsetClient, createHeadsetClientFromEnv, type HeadsetClient, type HeadsetClientConfig, type Product } from './client';

/** The context slice this connector needs: a Headset client at `ctx.connectors.headset`. */
export type HeadsetCtx = ConnectorContext<'headset', HeadsetClient>;

export function createHeadsetContext(config: HeadsetClientConfig): HeadsetCtx {
  return { connectors: { headset: createHeadsetClient(config) } };
}

/** From `HEADSET_BASE_URL` (default http://localhost:4600) and `HEADSET_API_TOKEN`. */
export function createHeadsetContextFromEnv(env: Record<string, string | undefined> = process.env, overrides: Partial<HeadsetClientConfig> = {}): HeadsetCtx {
  return { connectors: { headset: createHeadsetClientFromEnv(env, overrides) } };
}

/** Store and product names are identifiers from a third party: single line, capped. Never free text. */
export function label(v: string | null | undefined, max = 60): string {
  // eslint-disable-next-line no-control-regex
  const s = (v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export const SkuSelector = z
  .object({
    skus: z.array(z.string().min(1).max(64)).max(50).optional().describe('Distru/Headset SKUs, e.g. VAP-BD-1G'),
    product_names: z.array(z.string().min(1).max(120)).max(50).optional().describe('Product names (exact, or a unique partial match)'),
  })
  .refine((v) => (v.skus?.length ?? 0) + (v.product_names?.length ?? 0) > 0, { message: 'give at least one sku or product name' });

export interface Resolved {
  products: Product[];
  /** inputs that matched no product (or more than one, for partial names) */
  unmatched: string[];
}

/**
 * Resolves SKUs and product names against the Headset catalog. SKU match is case-insensitive;
 * names match exactly (case-insensitive) or by a unique substring.
 */
export async function resolveProducts(client: HeadsetClient, sel: { skus?: string[] | undefined; product_names?: string[] | undefined }): Promise<Resolved> {
  const catalog = await client.listProducts();
  const bySku = new Map(catalog.map((p) => [p.sku.toUpperCase(), p]));
  const found = new Map<string, Product>();
  const unmatched: string[] = [];
  for (const raw of sel.skus ?? []) {
    const p = bySku.get(raw.trim().toUpperCase());
    if (p) found.set(p.sku, p);
    else unmatched.push(label(raw));
  }
  for (const raw of sel.product_names ?? []) {
    const q = raw.trim().toLowerCase();
    const exact = catalog.find((p) => p.name.toLowerCase() === q);
    const partial = catalog.filter((p) => p.name.toLowerCase().includes(q));
    const p = exact ?? (partial.length === 1 ? partial[0] : undefined);
    if (p) found.set(p.sku, p);
    else unmatched.push(label(raw));
  }
  return { products: [...found.values()], unmatched };
}
