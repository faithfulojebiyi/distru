/**
 * Boundary schemas for the read-only "insight" routes: eval results (`eval_run`), the context layer's
 * account profile and memories, and the onboarding report. Every top-level schema has `.meta({ id })`.
 */
import { MemorySchema, ProductProfileSchema, RecallSearchResultSchema, RecallSourceSchema, VendorProfileSchema, type OnboardingReport } from '@ops/context';
import { z } from 'zod';

// ── Evals ────────────────────────────────────────────────────────────────────────────────────

export const EvalResultSchema = z
  .object({
    id: z.string(),
    batchId: z.string().nullable(),
    scenario: z.string(),
    passed: z.boolean(),
    /** pass_rate, assertions_passed/failed, cost_usd, input/output_tokens, llm_calls, latency_ms, judge? */
    scores: z.record(z.string(), z.number()),
    /** title, status, reason, mode, model, gitSha, assertions, usage (written by @ops/evals `--sink pg`). */
    details: z.unknown(),
    createdAt: z.string(),
  })
  .meta({ id: 'EvalResult' });
export type EvalResult = z.infer<typeof EvalResultSchema>;

export const EvalListSchema = z
  .object({ items: z.array(EvalResultSchema).describe('Latest row per scenario, by scenario name') })
  .meta({ id: 'EvalList' });

export const EvalHistorySchema = z
  .object({ scenario: z.string(), items: z.array(EvalResultSchema).describe('Newest first') })
  .meta({ id: 'EvalHistory' });

export const EvalScenarioParamsSchema = z.object({ scenario: z.string().min(1).max(200) });
export const EvalHistoryQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(30) });

// ── Context: profile + memories ──────────────────────────────────────────────────────────────

export const ContextProfileSchema = z
  .object({
    /** False until the first sync + profile build ran. */
    available: z.boolean(),
    version: z.number().int().nullable(),
    computedAt: z.string().nullable(),
    source: z.string().nullable(),
    counts: z
      .object({ vendors: z.number().int(), products: z.number().int(), customers: z.number().int(), purchases: z.number().int(), orders: z.number().int() })
      .nullable(),
    vendors: z.array(VendorProfileSchema),
    products: z.array(ProductProfileSchema),
    /** Last Distru sync runs (newest first) and cursors, for a sync-health panel. */
    sync: z.object({
      lastRunAt: z.string().nullable(),
      lastStatus: z.string().nullable(),
      cursors: z.array(z.object({ stream: z.string(), cursorAt: z.string(), lastFullAt: z.string(), lastRunAt: z.string() })),
    }),
  })
  .meta({ id: 'ContextProfile' });
export type ContextProfile = z.infer<typeof ContextProfileSchema>;

export const ContextMemorySchema = MemorySchema.extend({
  /** Confidence after time decay (what retrieval ranks by). */
  effectiveConfidence: z.number(),
}).meta({ id: 'ContextMemory' });

export const ContextMemoryListSchema = z.object({ items: z.array(ContextMemorySchema) }).meta({ id: 'ContextMemoryList' });

export const ContextMemoriesQuerySchema = z.object({
  scope: z.enum(['vendor', 'product', 'customer', 'global']).optional(),
  scopeId: z.string().optional(),
  status: z.enum(['active', 'expired', 'retracted']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

// ── Onboarding ───────────────────────────────────────────────────────────────────────────────

export const OnboardingReportSchema = z
  .object({
    generatedAt: z.string(),
    completeness: z.object({
      score: z.number(),
      products: z.object({ total: z.number(), active: z.number(), withSku: z.number(), withVendor: z.number(), withCost: z.number() }),
      companies: z.object({ vendors: z.number(), customers: z.number(), other: z.number() }),
      purchases: z.object({ total: z.number(), completed: z.number(), withOrderDate: z.number(), withReceipt: z.number(), from: z.string().nullable(), to: z.string().nullable() }),
      orders: z.object({ total: z.number(), withLines: z.number(), from: z.string().nullable(), to: z.string().nullable(), historyDays: z.number() }),
      inventory: z.object({ snapshotAt: z.string().nullable(), rows: z.number() }),
      issues: z.array(z.string()),
    }),
    vendorsMissingLeadTimes: z.array(z.object({ vendorId: z.string(), name: z.string(), observedMedianDays: z.number().nullable(), samples: z.number(), suggestion: z.string() })),
    suggestedPolicy: z.array(
      z.object({
        rule: z.object({ key: z.string(), params: z.record(z.string(), z.unknown()).optional(), enabled: z.boolean().optional() }),
        rationale: z.string(),
        evidence: z.record(z.string(), z.unknown()),
      }),
    ),
  })
  .meta({ id: 'OnboardingReport' });

// The package's report type must stay assignable to the schema (compile-time drift check).
export const assertOnboardingShape = (r: OnboardingReport): z.input<typeof OnboardingReportSchema> => r;

// ── Semantic recall ──────────────────────────────────────────────────────────────────────────

export const RecallSearchQuerySchema = z.object({
  q: z.string().trim().min(2).max(300).describe('What to look for, in plain words'),
  vendorId: z.string().min(1).max(100).optional().describe('Only text about this Distru vendor id'),
  since: z.iso.date().optional().describe('Only text written on or after this date (YYYY-MM-DD)'),
  source: RecallSourceSchema.optional().describe('email, vendor_reply or po_note (default: all)'),
  limit: z.coerce.number().int().min(1).max(8).default(5),
});

export const RecallSearchResponseSchema = RecallSearchResultSchema.extend({
  embedder: z.string().describe('Embedding model the index was built with'),
  documents: z.number().int().nullable().describe('Indexed documents'),
}).meta({ id: 'RecallSearchResponse' });
export type RecallSearchResponse = z.infer<typeof RecallSearchResponseSchema>;
