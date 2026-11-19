/**
 * Compliance check from batches, lab test results and Metrc packages.
 *
 * Distru has no pass/fail field on a test result, so failure is derived from:
 *  - the test result's title containing FAILED (labs/Distru import put the verdict there),
 *  - `additional_test_results` analytes above screening action levels (`ACTION_LEVELS`),
 *  - Metrc packages with status ONHOLD or `lab_testing_state` TestFailed (or requiring remediation).
 */
import type { BatchFull, DistruClient, MetrcPackage, TestResult } from '@ops/distru-client';
import { defineReadTool } from '@ops/harness';
import { z } from 'zod';
import { isoDay, label, num, type DistruCtx } from '../shared';
import { untrusted, UntrustedTextSchema } from '../untrusted';
import { productsById } from './catalog';

/**
 * Screening thresholds (California-style action levels; µg/g unless noted). Not legal advice:
 * the authoritative verdict is the COA. Microbials fail when detected at all.
 */
export const ACTION_LEVELS: Readonly<Record<string, number>> = {
  myclobutanil_ug_per_g: 0.1,
  bifenazate_ug_per_g: 0.1,
  imidacloprid_ug_per_g: 5,
  abamectin_ug_per_g: 0.1,
  lead_ug_per_g: 0.5,
  cadmium_ug_per_g: 0.2,
  arsenic_ug_per_g: 0.2,
  mercury_ug_per_g: 0.1,
  aspergillus_cfu_per_g: 0,
  aspergillus_flavus_cfu_per_g: 0,
  aspergillus_fumigatus_cfu_per_g: 0,
  aspergillus_niger_cfu_per_g: 0,
  aspergillus_terreus_cfu_per_g: 0,
  e_coli_cfu_per_g: 0,
  salmonella_cfu_per_g: 0,
  vitamin_e_acetate_percentage: 0,
};

export type TestVerdict = 'passed' | 'failed' | 'unknown';

/** Derives a verdict + reasons for one test result. */
export function evaluateTestResult(t: Pick<TestResult, 'name' | 'additional_test_results'>): { verdict: TestVerdict; reasons: string[] } {
  const reasons: string[] = [];
  const failedByName = /\bFAIL(ED|S)?\b/i.test(t.name);
  const passedByName = /\bPASS(ED|ES)?\b/i.test(t.name);
  if (failedByName) reasons.push('result title is marked FAILED');
  const additional: Record<string, string | null | undefined> = { ...t.additional_test_results };
  for (const [analyte, limit] of Object.entries(ACTION_LEVELS)) {
    const value = num(additional[analyte]);
    if (value !== null && value > limit) reasons.push(`${analyte} = ${value} exceeds action level ${limit}`);
  }
  if (reasons.length) return { verdict: 'failed', reasons };
  return { verdict: passedByName ? 'passed' : 'unknown', reasons: passedByName ? [] : ['result title has no PASSED/FAILED verdict'] };
}

export function packageProblem(p: Pick<MetrcPackage, 'status' | 'lab_testing_state' | 'product_requires_remediation' | 'label'>): string | null {
  const tag = label(p.label ?? 'unlabelled', 40);
  if (p.status === 'ONHOLD') return `Metrc package ${tag} is ONHOLD`;
  if (p.lab_testing_state && /fail/i.test(p.lab_testing_state)) return `Metrc package ${tag} lab_testing_state ${p.lab_testing_state}`;
  if (p.product_requires_remediation) return `Metrc package ${tag} requires remediation`;
  return null;
}

export const ComplianceCheckInput = z.object({
  product_ids: z.array(z.string().min(1)).min(1).max(25),
  batches_per_product: z.number().int().min(1).max(10).default(3).describe('How many of the newest batches to inspect.'),
});

const BatchCheckSchema = z.object({
  batch_id: z.string(),
  batch_number: z.string().nullable(),
  manufactured_date: z.string().nullable(),
  is_latest: z.boolean(),
  tests: z.array(
    z.object({
      id: z.string(),
      verdict: z.enum(['passed', 'failed', 'unknown']),
      lab_name: z.string().nullable(),
      release_date: z.string().nullable(),
      coa_url: z.string().nullable(),
      title: UntrustedTextSchema.nullable().describe('Lab result title as stored in Distru (untrusted text).'),
    }),
  ),
  packages: z.array(z.object({ label: z.string().nullable(), status: z.string(), lab_testing_state: z.string().nullable(), quantity: z.number().nullable() })),
});

export const ProductComplianceSchema = z.object({
  product_id: z.string(),
  sku: z.string().nullable(),
  name: z.string().nullable(),
  status: z.enum(['ok', 'blocked', 'unknown']).describe('blocked = do not reorder/sell until resolved; unknown = no lab evidence on file'),
  reasons: z.array(z.string()),
  batches: z.array(BatchCheckSchema),
});
export type ProductCompliance = z.infer<typeof ProductComplianceSchema>;

export const ComplianceCheckOutput = z.object({ products: z.array(ProductComplianceSchema) });

async function packagesByBatchNumber(client: DistruClient): Promise<Map<string, MetrcPackage[]>> {
  const packages = await client.listAll(client.listMetrcPackages, { statuses: ['ACTIVE', 'ONHOLD'] }, { maxPages: 100 });
  const out = new Map<string, MetrcPackage[]>();
  for (const p of packages) {
    const key = p.production_batch_number ?? p.package?.batch_number;
    if (!key) continue;
    out.set(key, [...(out.get(key) ?? []), p]);
  }
  return out;
}

async function checkProduct(
  client: DistruClient,
  productId: string,
  product: { sku: string; name: string } | undefined,
  packages: Map<string, MetrcPackage[]>,
  batchesPerProduct: number,
): Promise<ProductCompliance> {
  const [batches, tests] = await Promise.all([
    client.listAll(client.listBatches, { product_ids: [productId] }),
    client.listAll(client.listTestResults, { product_ids: [productId] }),
  ]);
  const newest = [...batches]
    .sort((a: BatchFull, b: BatchFull) => (a.manufactured_datetime < b.manufactured_datetime ? 1 : a.manufactured_datetime > b.manufactured_datetime ? -1 : 0))
    .slice(0, batchesPerProduct);
  const blocking: string[] = [];
  const warnings: string[] = [];
  let latestHasVerdict = false;

  const checked = newest.map((b, index) => {
    const isLatest = index === 0;
    const bn = b.batch_number ?? b.name;
    const batchTests = tests.filter((t) => t.batch_id === b.id);
    const evaluated = batchTests.map((t) => ({ t, ...evaluateTestResult(t) }));
    for (const e of evaluated) {
      if (e.verdict === 'failed') {
        const msg = `batch ${label(bn, 40)}: lab test failed (${e.reasons.join('; ')})`;
        (isLatest ? blocking : warnings).push(isLatest ? msg : `older ${msg}`);
      }
      if (isLatest && e.verdict !== 'unknown') latestHasVerdict = true;
    }
    const pkgs = packages.get(bn) ?? [];
    for (const p of pkgs) {
      const problem = packageProblem(p);
      // Any package with stock that is held/failed blocks, whatever the batch age.
      if (problem) blocking.push(`batch ${label(bn, 40)}: ${problem}`);
    }
    return {
      batch_id: b.id,
      batch_number: bn ? label(bn, 60) : null,
      manufactured_date: isoDay(b.manufactured_datetime),
      is_latest: isLatest,
      tests: evaluated.map(({ t, verdict }) => ({
        id: t.id,
        verdict,
        lab_name: t.lab_name ? label(t.lab_name) : null,
        release_date: t.release_date ?? null,
        coa_url: t.coa_url ?? null,
        title: untrusted(t.name, 'distru.test_result.name'),
      })),
      packages: pkgs.map((p) => ({ label: p.label ?? null, status: p.status, lab_testing_state: p.lab_testing_state ?? null, quantity: num(p.quantity) })),
    };
  });

  let status: ProductCompliance['status'];
  const reasons = [...new Set(blocking)];
  if (reasons.length) status = 'blocked';
  else if (!newest.length) {
    status = 'unknown';
    reasons.push('no batches on file (product-tracked SKU or never received)');
  } else if (!latestHasVerdict) {
    status = 'unknown';
    reasons.push('latest batch has no lab result with a PASSED/FAILED verdict');
  } else status = 'ok';
  reasons.push(...warnings);
  return {
    product_id: productId,
    sku: product ? label(product.sku, 60) : null,
    name: product ? label(product.name) : null,
    status,
    reasons,
    batches: checked,
  };
}

export const complianceCheckTool = defineReadTool({
  name: 'compliance_check',
  description:
    'Compliance status per product from its newest batches, lab test results and Metrc packages: ok | blocked (failed lab test, package ONHOLD/TestFailed) | unknown (no lab evidence), with reasons. Never reorder a blocked product.',
  input: ComplianceCheckInput,
  output: ComplianceCheckOutput,
  run: async (ctx: DistruCtx, input) => {
    const client = ctx.connectors.distru;
    const ids = [...new Set(input.product_ids)];
    const [products, packages] = await Promise.all([productsById(client, ids), packagesByBatchNumber(client)]);
    const results: ProductCompliance[] = [];
    // small fan-out: 2 requests per product, a few products at a time
    for (let i = 0; i < ids.length; i += 4) {
      const chunk = ids.slice(i, i + 4);
      results.push(...(await Promise.all(chunk.map((id) => checkProduct(client, id, products.get(id), packages, input.batches_per_product)))));
    }
    return { products: results };
  },
});
