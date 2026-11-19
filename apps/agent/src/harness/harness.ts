import {
  createHarness,
  inlineStepRunner,
  systemClock,
  type Clock,
  type ErrorClassifier,
  type Harness,
  type HarnessConfig,
  type IdGenerator,
  type PolicyEngine,
  type Registry,
  type StepRunner,
} from '@ops/harness';
import { db as defaultDb, type DB } from '../db/client';
import { DrizzleAuditSink } from './audit-sink';
import { appPolicyEngine } from './policy';
import { DrizzlePolicyRuleSource } from './policy-rules';
import { DrizzleProposalStore } from './proposal-store';

export interface AppHarnessOptions<TCtx> {
  /** The registry, or a getter for the current one (the app rebuilds it when MCP tools change). */
  registry: Registry<TCtx> | (() => Registry<TCtx>);
  /** Policy engine; default: the app engine (harness built-ins + connector rules such as email_recipient_domains). */
  policyEngine?: PolicyEngine;
  /** Defaults to the app's Drizzle client. */
  db?: DB;
  /**
   * Default step runner for `harness.execute`. Inline by default; a durable caller passes its own
   * per call site instead (see `inngestStepRunner`) by building a harness with `steps`.
   */
  steps?: StepRunner;
  /** ERP error classification (Distru: 429/5xx retryable, `Retry-After`). Defaults to "never retry". */
  errors?: ErrorClassifier;
  clock?: Clock;
  ids?: IdGenerator;
  /** Escape hatch for anything else in HarnessConfig (retry policy, separation of duties, …). */
  config?: Partial<Omit<HarnessConfig<TCtx>, 'registry' | 'store' | 'audit' | 'policyRules'>>;
}

/**
 * The app's harness: Postgres-backed ports + system clock. Construct it once per process (per
 * registry); it is stateless apart from its ports, so it is safe to share between requests.
 */
export function createAppHarness<TCtx>(options: AppHarnessOptions<TCtx>): Harness<TCtx> {
  const db = options.db ?? defaultDb;
  return createHarness<TCtx>({
    registry: options.registry,
    store: new DrizzleProposalStore(db),
    audit: new DrizzleAuditSink(db),
    policyRules: new DrizzlePolicyRuleSource(db),
    clock: options.clock ?? systemClock,
    steps: options.steps ?? inlineStepRunner,
    ...(options.errors ? { errors: options.errors } : {}),
    ...(options.ids ? { ids: options.ids } : {}),
    policyEngine: options.policyEngine ?? appPolicyEngine,
    ...options.config,
  });
}

// ---------------------------------------------------------------------------------------------
// Durable step runners
// ---------------------------------------------------------------------------------------------

/** The slice of Inngest's `step` tools the harness needs. Structural, so we don't import `inngest` types here. */
export interface InngestStepLike {
  run(id: string, fn: () => Promise<unknown>): Promise<unknown>;
}

/**
 * Adapts Inngest step tools to the harness `StepRunner`, giving one memoized, retried Inngest step
 * per harness step (`proposal:<id>:start`, `:op:<i>`, `:finish`). Use it where you own the Inngest
 * `step` object directly, e.g. an `inngest.createFunction(..., async ({ step }) => …)` handler:
 *
 *   const harness = createAppHarness({ registry, steps: inngestStepRunner(step) });
 *   await harness.execute({ ctx, proposalId });
 *
 * Inngest stores step results as JSON and returns the stored JSON on replay. Every harness step
 * returns a plain JSON value (a Proposal or ProposalOp), so the round-trip is lossless and the
 * cast back to `T` is sound.
 *
 * Inside a **Mastra workflow step** (`createStep` from `src/mastra/inngest.ts`) do NOT nest
 * `step.run`: @mastra/inngest already runs each Mastra step as a durable Inngest step (the raw
 * tools are exposed as `execute({ engine }) => engine.step`, but nesting step tools inside a
 * running step is not allowed by Inngest). There, keep the default inline runner: the Mastra step
 * is the durable boundary, and re-running `harness.execute` after a crash is safe because executed
 * ops are skipped and every write is deduplicated by its idempotency key.
 */
export function inngestStepRunner(step: InngestStepLike): StepRunner {
  return {
    run: async <T>(stepId: string, fn: () => Promise<T>): Promise<T> => (await step.run(stepId, fn)) as T,
  };
}
