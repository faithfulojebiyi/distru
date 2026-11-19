import type { AuditEvent, AuditEventOf, AuditEventType } from './audit';
import type { PolicyRuleConfig } from './policy';
import type { AuditSink, Clock, IdGenerator, PolicyRuleSource, ProposalStore, StepRunner } from './ports';
import type { Proposal, ProposalStatus } from './proposal';
import { CancelledError } from './errors';

/** In-memory `ProposalStore`. Values are cloned in and out, like a real database. */
export class InMemoryProposalStore implements ProposalStore {
  readonly #rows = new Map<string, Proposal>();

  async create(proposal: Proposal): Promise<void> {
    if (this.#rows.has(proposal.id)) throw new Error(`Proposal ${proposal.id} already exists`);
    this.#rows.set(proposal.id, structuredClone(proposal));
  }

  async get(id: string): Promise<Proposal | null> {
    const row = this.#rows.get(id);
    return row ? structuredClone(row) : null;
  }

  async compareAndSet(next: Proposal, expectedVersion: number): Promise<boolean> {
    // No await between check and set: atomic on the JS event loop.
    const row = this.#rows.get(next.id);
    if (!row || row.version !== expectedVersion) return false;
    this.#rows.set(next.id, structuredClone(next));
    return true;
  }

  async list(filter: { status?: ProposalStatus } = {}): Promise<Proposal[]> {
    return [...this.#rows.values()].filter((p) => !filter.status || p.status === filter.status).map((p) => structuredClone(p));
  }
}

export class InMemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];

  async append(event: AuditEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }

  ofType<T extends AuditEventType>(type: T): AuditEventOf<T>[] {
    return this.events.filter((e): e is AuditEventOf<T> => e.type === type);
  }

  forProposal(proposalId: string): AuditEvent[] {
    return this.events.filter((e) => e.proposalId === proposalId);
  }

  types(proposalId?: string): AuditEventType[] {
    return (proposalId ? this.forProposal(proposalId) : this.events).map((e) => e.type);
  }
}

export class StaticPolicyRules implements PolicyRuleSource {
  rules: PolicyRuleConfig[];
  constructor(rules: PolicyRuleConfig[] = []) {
    this.rules = rules;
  }
  async list(): Promise<readonly PolicyRuleConfig[]> {
    return this.rules;
  }
}

/** Deterministic clock: `sleep` resolves immediately and advances time; sleeps are recorded. */
export class FakeClock implements Clock {
  #now: number;
  readonly sleeps: number[] = [];

  constructor(start: Date | string = '2026-01-01T00:00:00.000Z') {
    this.#now = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.#now);
  }

  advance(ms: number): void {
    this.#now += ms;
  }

  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new CancelledError('Sleep aborted');
    this.sleeps.push(ms);
    this.#now += ms;
  }
}

/** Sequential ids (`prefix-1`, `prefix-2`, …) for readable, deterministic tests. */
export function sequentialIds(prefix = 'id'): IdGenerator {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

/**
 * Memoizing step runner that mimics a durable engine: a step that completed returns its stored
 * result on replay instead of running again. Useful to test crash/resume semantics.
 */
export class MemoStepRunner implements StepRunner {
  readonly results = new Map<string, unknown>();
  readonly calls: string[] = [];

  async run<T>(stepId: string, fn: () => Promise<T>): Promise<T> {
    this.calls.push(stepId);
    // Same contract as a durable engine: the stored value is the one this step id returned before.
    if (this.results.has(stepId)) return structuredClone(this.results.get(stepId)) as T;
    const value = await fn();
    this.results.set(stepId, structuredClone(value));
    return value;
  }
}
