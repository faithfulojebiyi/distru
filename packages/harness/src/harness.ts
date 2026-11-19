import type { HarnessDeps } from './context';
import { loadProposal } from './context';
import { executeProposal, type ExecuteArgs } from './executor';
import { PolicyEngine } from './policy';
import type { AuditSink, Clock, ErrorClassifier, IdGenerator, PolicyRuleSource, ProposalStore, StepRunner } from './ports';
import type { Proposal } from './proposal';
import { decide, propose, type DecideArgs, type ProposeArgs } from './proposals';
import type { Registry } from './registry';
import { neverRetry, RetryPolicySchema, type RetryPolicy } from './retry';
import { inlineStepRunner, randomId, systemClock } from './runtime';
import { undo, undoInfo, type UndoArgs, type UndoInfo } from './undo';

export interface HarnessConfig<TCtx> {
  /**
   * The action registry, or a function returning the current one (read on every use). Pass a
   * function when the registry is rebuilt at runtime, e.g. after an MCP connector's tool list
   * changes, so one harness always sees the latest connectors.
   */
  registry: Registry<TCtx> | (() => Registry<TCtx>);
  store: ProposalStore;
  audit: AuditSink;
  policyRules: PolicyRuleSource;
  /** Defaults to an engine with the built-in rules. */
  policyEngine?: PolicyEngine;
  clock?: Clock;
  ids?: IdGenerator;
  /** Defaults to an inline (non-durable) runner. */
  steps?: StepRunner;
  /** Defaults to "nothing is retryable". */
  errors?: ErrorClassifier;
  retry?: Partial<RetryPolicy>;
  /** Jitter source; inject for deterministic tests. */
  random?: () => number;
  /** Reject decisions made by the proposal's own creator. Default true. */
  separationOfDuties?: boolean;
  /** How long after execution a proposal may be undone (ms). Default: no limit. */
  undoWindowMs?: number;
}

/** The action harness: propose → (policy) → decide → execute, with audit at every step. */
export class Harness<TCtx> {
  readonly #deps: HarnessDeps<TCtx>;
  readonly #undoWindowMs: number | null;

  constructor(config: HarnessConfig<TCtx>) {
    this.#undoWindowMs = config.undoWindowMs ?? null;
    const source = config.registry;
    const current = typeof source === 'function' ? source : () => source;
    this.#deps = {
      get registry() {
        return current();
      },
      store: config.store,
      audit: config.audit,
      policyRules: config.policyRules,
      policyEngine: config.policyEngine ?? new PolicyEngine(),
      clock: config.clock ?? systemClock,
      ids: config.ids ?? randomId,
      steps: config.steps ?? inlineStepRunner,
      errors: config.errors ?? neverRetry,
      retry: RetryPolicySchema.parse(config.retry ?? {}),
      random: config.random ?? Math.random,
      separationOfDuties: config.separationOfDuties ?? true,
    };
  }

  get registry(): Registry<TCtx> {
    return this.#deps.registry;
  }

  /** Build a changeset (validated, planned, diffed, policy-evaluated) and persist it. Never writes to the ERP. */
  propose(args: ProposeArgs<TCtx>): Promise<Proposal> {
    return propose(this.#deps, args);
  }

  /** Record exactly one approve/reject decision (requires the `approve` scope). */
  decide(args: DecideArgs<TCtx>): Promise<Proposal> {
    return decide(this.#deps, args);
  }

  /** Apply an approved/auto-approved proposal; idempotent and resumable. */
  execute(args: ExecuteArgs<TCtx>): Promise<Proposal> {
    return executeProposal(this.#deps, args);
  }

  /**
   * Propose undoing executed ops: creates a NEW proposal of compensating ops (reverse order,
   * `meta.undoOf`) that needs policy + approval + execution like any change. Never writes.
   */
  undo(args: UndoArgs<TCtx>): Promise<Proposal> {
    return undo(this.#deps, args, this.#undoWindowMs);
  }

  /** Which ops of a proposal can be undone now, and why not. */
  undoInfo(proposal: Proposal | string): Promise<UndoInfo> {
    return undoInfo(this.#deps, proposal, this.#undoWindowMs);
  }

  get(proposalId: string): Promise<Proposal> {
    return loadProposal(this.#deps, proposalId);
  }
}

export function createHarness<TCtx>(config: HarnessConfig<TCtx>): Harness<TCtx> {
  return new Harness(config);
}
