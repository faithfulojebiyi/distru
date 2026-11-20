import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  agentPrincipal,
  createHarness,
  defineAction,
  FakeClock,
  InMemoryAuditSink,
  InMemoryProposalStore,
  matchesExpected,
  PolicyEngine,
  Registry,
  sequentialIds,
  StaticPolicyRules,
  inlineStepRunner,
  userPrincipal,
} from '@ops/harness';
import { z } from 'zod';
import { traceAudit, traceHarness, tracePolicyEngine, traceRegistry, traceSteps } from '../src/harness/tracing';

interface Note {
  text: string;
  key: string;
}
interface Ctx {
  notes: Map<string, Note>;
}

const noteAction = defineAction<Ctx, { text: string }, { text: string }, Note>({
  name: 'notes.create',
  resource: 'notes',
  description: 'Write a note.',
  risk: 'low',
  moneyless: true,
  valueOf: () => null,
  input: z.object({ text: z.string() }),
  payload: z.object({ text: z.string() }),
  loadBefore: async (_ctx: Ctx): Promise<Note | null> => null,
  plan: (_ctx: Ctx, input) => ({ text: input.text }),
  execute: async (ctx: Ctx, payload, key) => {
    const id = `n-${ctx.notes.size + 1}`;
    const note: Note = { text: payload.text, key };
    ctx.notes.set(id, note);
    return { recordId: id, record: note };
  },
  verify: async (ctx: Ctx, id, expected) => matchesExpected(ctx.notes.get(id), expected),
  findByIdempotencyKey: async (ctx: Ctx, key) => {
    for (const [id, note] of ctx.notes) if (note.key === key) return { recordId: id, record: note };
    return null;
  },
});

const spans = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] });

beforeAll(() => provider.register());
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
});

describe('harness tracing', () => {
  test('propose, policy, decide, execute, step, write and verify become nested spans', async () => {
    const registry = new Registry<Ctx>({ actions: [noteAction] });
    const harness = traceHarness(
      createHarness<Ctx>({
        registry: traceRegistry(() => registry),
        store: new InMemoryProposalStore(),
        audit: traceAudit(new InMemoryAuditSink()),
        clock: new FakeClock(),
        policyRules: new StaticPolicyRules([]),
        policyEngine: tracePolicyEngine(new PolicyEngine()),
        steps: traceSteps(inlineStepRunner),
        ids: sequentialIds('p'),
      }),
    );
    const ctx: Ctx = { notes: new Map() };

    const proposed = await harness.propose({ ctx, principal: agentPrincipal('planner'), ops: [{ action: 'notes.create', input: { text: 'hi' } }] });
    await harness.decide({ ctx, principal: userPrincipal('u-1', 'approver'), proposalId: proposed.id, decision: 'approve' });
    const done = await harness.execute({ ctx, proposalId: proposed.id });
    expect(done.status).toBe('executed');

    const finished = spans.getFinishedSpans();
    const byName = (name: string) => finished.filter((s) => s.name === name);
    const parentOf = (name: string) => {
      const parentId = byName(name)[0]?.parentSpanContext?.spanId;
      return finished.find((s) => s.spanContext().spanId === parentId)?.name;
    };

    expect(byName('harness.propose')[0]?.attributes['ops.proposal.status']).toBe('pending_approval');
    expect(parentOf('harness.policy')).toBe('harness.propose');
    expect(byName('harness.decide')[0]?.attributes['ops.proposal.status']).toBe('approved');
    expect(byName('harness.step').map((s) => s.attributes['ops.step.kind'])).toEqual(['start', 'op', 'finish']);
    expect(parentOf('harness.step')).toBe('harness.execute');
    expect(parentOf('harness.write')).toBe('harness.step');
    expect(byName('harness.verify')[0]?.attributes['ops.verify.ok']).toBe(true);
    // Audit events land on the active span: op.executed / op.verified on the op step.
    const opStep = byName('harness.step').find((s) => s.attributes['ops.step.kind'] === 'op');
    expect(opStep?.events.map((e) => e.name)).toEqual(expect.arrayContaining(['op.executed', 'op.verified']));
  });
});
