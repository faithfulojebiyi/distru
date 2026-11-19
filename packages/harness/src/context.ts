import type { AuditEventInput } from './audit';
import { ConcurrentModificationError, NotFoundError } from './errors';
import type { PolicyEngine } from './policy';
import type { AuditSink, Clock, ErrorClassifier, IdGenerator, PolicyRuleSource, ProposalStore, StepRunner } from './ports';
import type { Proposal } from './proposal';
import type { Registry } from './registry';
import type { RetryPolicy } from './retry';

/** Fully-resolved harness dependencies (config with defaults applied). Internal. */
export interface HarnessDeps<TCtx> {
  registry: Registry<TCtx>;
  store: ProposalStore;
  audit: AuditSink;
  policyRules: PolicyRuleSource;
  policyEngine: PolicyEngine;
  clock: Clock;
  ids: IdGenerator;
  steps: StepRunner;
  errors: ErrorClassifier;
  retry: RetryPolicy;
  random: () => number;
  separationOfDuties: boolean;
}

export const nowIso = (deps: Pick<HarnessDeps<unknown>, 'clock'>): string => deps.clock.now().toISOString();

export async function emit(deps: Pick<HarnessDeps<unknown>, 'audit' | 'ids' | 'clock'>, event: AuditEventInput): Promise<void> {
  await deps.audit.append({ ...event, id: deps.ids(), at: nowIso(deps) });
}

export async function loadProposal(deps: Pick<HarnessDeps<unknown>, 'store'>, id: string): Promise<Proposal> {
  const proposal = await deps.store.get(id);
  if (!proposal) throw new NotFoundError(`Proposal ${id} not found`);
  return proposal;
}

/** Optimistic write: applies `mutate` and CASes on `current.version`. */
export async function saveProposal(
  deps: Pick<HarnessDeps<unknown>, 'store' | 'clock'>,
  current: Proposal,
  mutate: (p: Proposal) => Proposal,
): Promise<Proposal> {
  const next: Proposal = { ...mutate(current), version: current.version + 1, updatedAt: nowIso(deps) };
  if (!(await deps.store.compareAndSet(next, current.version))) {
    throw new ConcurrentModificationError(`Proposal ${current.id} was modified concurrently (expected v${current.version})`);
  }
  return next;
}
