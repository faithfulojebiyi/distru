import { SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';
import type { AnyAction, AuditSink, Harness, PolicyEngine, Proposal, Registry, StepRunner } from '@ops/harness';

/**
 * OpenTelemetry spans around the harness, added from the outside so packages/harness stays free of
 * infra imports. Every wrapper decorates a port or the harness object itself:
 *
 *   harness.propose ─┬─ harness.policy                 (PolicyEngine.evaluate)
 *   harness.decide  ─┘
 *   harness.execute ── harness.step (start | op | finish, the StepRunner)
 *                         ├─ harness.write             (action.execute / action.compensate)
 *                         └─ harness.verify            (action.verify, read-after-write)
 *
 * Audit events become span events on whichever span is active. Spans only leave the process when a
 * global tracer provider is registered (src/observability/otel.ts); otherwise the API hands out no-ops.
 */
const tracer = () => trace.getTracer('ops-agent.harness');

function fail(span: Span, err: unknown): void {
  span.recordException(err instanceof Error ? err : String(err));
  span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
}

export function inSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      fail(span, err);
      throw err;
    } finally {
      span.end();
    }
  });
}

function inSpanSync<T>(name: string, attributes: Attributes, fn: (span: Span) => T): T {
  return tracer().startActiveSpan(name, { attributes }, (span) => {
    try {
      return fn(span);
    } catch (err) {
      fail(span, err);
      throw err;
    } finally {
      span.end();
    }
  });
}

function proposalResult(span: Span, p: Proposal): Proposal {
  span.setAttributes({ 'ops.proposal.id': p.id, 'ops.proposal.status': p.status, 'ops.policy.outcome': p.policy.outcome });
  if (p.status === 'failed') span.setStatus({ code: SpanStatusCode.ERROR, message: p.execution?.error?.message ?? 'proposal failed' });
  return p;
}

/** Spans for propose / decide / execute / undo on this harness instance (mutates and returns it). */
export function traceHarness<TCtx>(harness: Harness<TCtx>): Harness<TCtx> {
  const propose = harness.propose.bind(harness);
  const decide = harness.decide.bind(harness);
  const execute = harness.execute.bind(harness);
  const undo = harness.undo.bind(harness);
  harness.propose = (args) =>
    inSpan(
      'harness.propose',
      {
        'ops.principal.kind': args.principal.kind,
        'ops.principal.id': args.principal.id,
        'ops.op.count': args.ops.length,
        'ops.actions': [...new Set(args.ops.map((op) => op.action))],
      },
      async (span) => proposalResult(span, await propose(args)),
    );
  harness.decide = (args) =>
    inSpan(
      'harness.decide',
      { 'ops.proposal.id': args.proposalId, 'ops.decision': args.decision, 'ops.principal.kind': args.principal.kind, 'ops.principal.id': args.principal.id },
      async (span) => proposalResult(span, await decide(args)),
    );
  harness.execute = (args) => inSpan('harness.execute', { 'ops.proposal.id': args.proposalId }, async (span) => proposalResult(span, await execute(args)));
  harness.undo = (args) => inSpan('harness.undo', { 'ops.principal.id': args.principal.id }, async (span) => proposalResult(span, await undo(args)));
  return harness;
}

/**
 * Forwards every property to `target` with `this` bound to it (the harness classes use `#private`
 * fields, which a plain prototype wrapper would break), overriding only `overrides`.
 */
function decorate<T extends object>(target: T, overrides: Partial<T>): T {
  return new Proxy(target, {
    get(t, prop) {
      if (Object.hasOwn(overrides, prop)) return Reflect.get(overrides, prop);
      const value: unknown = Reflect.get(t, prop, t);
      return typeof value === 'function' ? value.bind(t) : value;
    },
  });
}

/** `harness.policy` around every evaluation (propose, decide-with-edits, dry runs). */
export function tracePolicyEngine(engine: PolicyEngine): PolicyEngine {
  return decorate(engine, {
    evaluate: (subject, configs) =>
      inSpanSync('harness.policy', { 'ops.op.count': subject.ops.length, 'ops.policy.rule_count': configs.length }, (span) => {
        const evaluation = engine.evaluate(subject, configs);
        span.setAttributes({
          'ops.policy.outcome': evaluation.outcome,
          'ops.policy.reasons': evaluation.reasons.map((r) => `${r.rule}: ${r.outcome}`),
        });
        return evaluation;
      }),
  });
}

function traceAction<TCtx>(action: AnyAction<TCtx>): AnyAction<TCtx> {
  const attrs = (more: Attributes = {}): Attributes => ({ 'ops.action': action.name, ...more });
  const compensate = action.compensate;
  return {
    ...action,
    execute: (ctx, payload, idempotencyKey) =>
      inSpan('harness.write', attrs({ 'ops.idempotency_key': idempotencyKey }), async (span) => {
        const written = await action.execute(ctx, payload, idempotencyKey);
        span.setAttribute('ops.record.id', written.recordId);
        return written;
      }),
    verify: (ctx, recordId, expected) =>
      inSpan('harness.verify', attrs({ 'ops.record.id': recordId }), async (span) => {
        const result = await action.verify(ctx, recordId, expected);
        span.setAttribute('ops.verify.ok', result.ok);
        if (!result.ok) {
          span.setAttribute('ops.verify.mismatches', result.mismatches.length);
          span.setStatus({ code: SpanStatusCode.ERROR, message: `${result.mismatches.length} mismatch(es)` });
        }
        return result;
      }),
    ...(compensate
      ? {
          compensate: (ctx: TCtx, op: Parameters<typeof compensate>[1], result: Parameters<typeof compensate>[2]) =>
            inSpan('harness.write', attrs({ 'ops.compensation': true }), () => compensate(ctx, op, result)),
        }
      : {}),
  };
}

/**
 * A registry source whose actions emit write/verify spans. Follows registry rebuilds (MCP tool
 * changes) and keeps one wrapped action per action object.
 */
export function traceRegistry<TCtx>(source: () => Registry<TCtx>): () => Registry<TCtx> {
  let current: Registry<TCtx> | undefined;
  let traced: Registry<TCtx> | undefined;
  const actions = new WeakMap<AnyAction<TCtx>, AnyAction<TCtx>>();
  return () => {
    const registry = source();
    if (registry !== current || !traced) {
      current = registry;
      traced = decorate(registry, {
        action: (name: string) => {
          const action = registry.action(name);
          let wrapped = actions.get(action);
          if (!wrapped) actions.set(action, (wrapped = traceAction(action)));
          return wrapped;
        },
      });
    }
    return traced;
  };
}

/** One `harness.step` span per durable step (`proposal:<id>:start`, `:op:<i>`, `:finish`). */
export function traceSteps(steps: StepRunner): StepRunner {
  return {
    run: <T>(stepId: string, fn: () => Promise<T>): Promise<T> => {
      const [, proposalId, kind, index] = stepId.split(':');
      return inSpan(
        'harness.step',
        {
          'ops.step.id': stepId,
          ...(proposalId ? { 'ops.proposal.id': proposalId } : {}),
          ...(kind ? { 'ops.step.kind': kind } : {}),
          ...(index !== undefined ? { 'ops.op.index': Number(index) } : {}),
        },
        () => steps.run(stepId, fn),
      );
    },
  };
}

/** Audit events as span events on the active span (the audit table stays the source of truth). */
export function traceAudit(sink: AuditSink): AuditSink {
  return {
    append: async (event) => {
      trace.getActiveSpan()?.addEvent(event.type, {
        ...(event.proposalId ? { 'ops.proposal.id': event.proposalId } : {}),
        'ops.actor': `${event.actor.kind}:${event.actor.id}`,
      });
      await sink.append(event);
    },
  };
}
