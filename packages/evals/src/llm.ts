import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { createEmulator, llm, llmCalls, seedLlm, type Emulator } from '@ops/emulators';
import type { Usage } from './observation';

/**
 * Every model call an eval makes goes through the LLM emulator (`@ops/emulators` → `llm`):
 *
 * - **offline**: replay only. Calls are answered from the scenario's recording
 *   (`recordings/<id>.json`, keyed by a fingerprint of the exact request). An unrecorded call is a
 *   500 ("no script answers"), so a prompt/tool change that alters a request shows up as a stale
 *   recording instead of silently calling a model. No key, no network, no spend.
 * - **record**: a call missing from the recording goes once to the real Anthropic API with the key,
 *   and its answer (with the real token usage) is appended to the recording. Keys stay in memory and
 *   are scrubbed from what is saved.
 * - **live**: like record, into a throwaway file: every call hits the real model.
 *
 * Mastra resolves `anthropic/<model>` through its model router, which reads `ANTHROPIC_BASE_URL`.
 * The gateway sets it once to a local Bun server that rewrites each request to
 * `https://api.anthropic.com/...` and hands it to the current scenario's emulator in-process.
 * (Set once per process because Mastra caches model instances with their base URL.)
 */
export type EvalMode = 'offline' | 'record' | 'live';

export interface Pricing {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

/** What the evals assume for cost (same defaults as the agent's LLM_*_USD_PER_MTOK estimate). */
export const DEFAULT_PRICING: Pricing = { inputUsdPerMTok: 3, outputUsdPerMTok: 15 };

/** The key the SDK sends to the emulator; the emulator swaps in the real one when recording. */
export const EMULATED_KEY = 'emulated-key-not-a-secret';

export class BudgetExceeded extends Error {
  constructor(spent: number, budget: number) {
    super(`eval LLM budget exceeded: $${spent.toFixed(4)} spent of $${budget.toFixed(2)}`);
    this.name = 'BudgetExceeded';
  }
}

export interface SessionOptions {
  mode: EvalMode;
  /** Recording file for this scenario (offline/record). */
  recording: string;
  model: string;
  pricing: Pricing;
  /** Real Anthropic key (record/live only). Never logged. */
  apiKey?: string;
  /** Hard stop for real spend across the whole process (record/live). */
  budgetUsd?: number;
}

/** One scenario's emulator: its calls, usage and whether it reached the real provider. */
export class LlmSession {
  readonly emulator: Emulator;
  readonly options: SessionOptions;

  constructor(options: SessionOptions, gateway: LlmGateway) {
    this.options = options;
    this.emulator = createEmulator(llm);
    const prices = { [options.model]: { input: options.pricing.inputUsdPerMTok, output: options.pricing.outputUsdPerMTok } };
    if (options.mode === 'offline') {
      seedLlm(this.emulator.store, { unscripted: 'fail', prices, record: { file: options.recording } });
    } else {
      if (!options.apiKey) throw new Error(`${options.mode} mode needs ANTHROPIC_API_KEY (env or apps/agent/.env)`);
      mkdirSync(dirname(options.recording), { recursive: true });
      seedLlm(this.emulator.store, {
        unscripted: 'fail',
        prices,
        record: { file: options.recording, keys: { anthropic: options.apiKey }, fetch: gateway.guardedFetch(this) },
      });
    }
  }

  usage(): Usage {
    const calls = llmCalls(this.emulator).all();
    const inputTokens = calls.reduce((n, c) => n + c.usage.input, 0);
    const outputTokens = calls.reduce((n, c) => n + c.usage.output, 0);
    return { llmCalls: calls.length, inputTokens, outputTokens, costUsd: round6(llmCalls(this.emulator).cost()) };
  }

  /** Calls that went to the real provider in this session (recorded now, not replayed). */
  recordedCalls(): number {
    return llmCalls(this.emulator)
      .all()
      .filter((c) => c.script === 'recorded').length;
  }

  /** Random ids of the world (e.g. Gmail ids from the emulators) to alias before fingerprinting. */
  volatile: (() => readonly string[]) | null = null;
  readonly #aliases = new Map<string, string>();

  /**
   * Replaces every volatile id in a request body with a stable alias (`vol-1`, `vol-2`, … in order of
   * first appearance in this session), so a request built from random ids still matches its recording.
   */
  normalize(body: string): string {
    const values = this.volatile?.() ?? [];
    if (!values.length) return body;
    const present = values.filter((v) => body.includes(v)).sort((a, b) => body.indexOf(a) - body.indexOf(b) || b.length - a.length);
    let out = body;
    for (const v of present) {
      let alias = this.#aliases.get(v);
      if (!alias) {
        alias = `vol-${this.#aliases.size + 1}`;
        this.#aliases.set(v, alias);
      }
      out = out.split(v).join(alias);
    }
    return out;
  }

  /** Calls nothing answered (stale or missing recording in offline mode). */
  unanswered(): number {
    return llmCalls(this.emulator)
      .all()
      .filter((c) => c.script === null).length;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export class LlmGateway {
  #server: ReturnType<typeof Bun.serve> | null = null;
  #current: LlmSession | null = null;
  /** Real dollars spent in this process (record/live). */
  spentUsd = 0;
  readonly budgetUsd: number;

  constructor(options: { budgetUsd?: number } = {}) {
    this.budgetUsd = options.budgetUsd ?? 5;
  }

  /** Starts the local endpoint and points ANTHROPIC_BASE_URL at it. Idempotent. */
  start(): string {
    if (!this.#server) {
      this.#server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        idleTimeout: 255,
        fetch: async (req) => {
          const session = this.#current;
          if (!session) return Response.json({ type: 'error', error: { type: 'api_error', message: 'no eval session attached' } }, { status: 500 });
          const url = new URL(req.url);
          const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
          const headers = new Headers(req.headers);
          headers.delete('content-length');
          const upstream = new Request(`https://api.anthropic.com${url.pathname}${url.search}`, {
            method: req.method,
            headers,
            ...(hasBody ? { body: session.normalize(await req.text()) } : {}),
          });
          return session.emulator.fetch(upstream);
        },
      });
    }
    const base = `http://127.0.0.1:${this.#server.port}/v1`;
    process.env.ANTHROPIC_BASE_URL = base;
    return base;
  }

  session(options: SessionOptions): LlmSession {
    this.start();
    const session = new LlmSession(options, this);
    this.#current = session;
    return session;
  }

  detach(session: LlmSession): void {
    if (this.#current === session) this.#current = null;
  }

  /**
   * The fetch a recording session uses to reach Anthropic: refuses once the process budget is
   * spent, and adds each real answer's cost to the running total.
   */
  guardedFetch(session: LlmSession) {
    return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (this.spentUsd >= this.budgetUsd) throw new BudgetExceeded(this.spentUsd, this.budgetUsd);
      const res = await fetch(input, init);
      if (res.ok) {
        const body: unknown = await res.clone().json();
        const usage = isRecord(body) && isRecord(body.usage) ? body.usage : null;
        const n = (v: unknown) => (typeof v === 'number' ? v : 0);
        if (usage) {
          const input = n(usage.input_tokens) + n(usage.cache_creation_input_tokens) + n(usage.cache_read_input_tokens);
          const p = session.options.pricing;
          this.spentUsd += (input * p.inputUsdPerMTok + n(usage.output_tokens) * p.outputUsdPerMTok) / 1_000_000;
        }
      }
      return res;
    };
  }

  async stop(): Promise<void> {
    await this.#server?.stop(true);
    this.#server = null;
  }
}

/** Mastra model config for an Anthropic model through the gateway. */
export function anthropicModel(model: string) {
  return { id: `anthropic/${model}` as const, apiKey: EMULATED_KEY };
}

export function recordingExists(file: string): boolean {
  return existsSync(file);
}

export function removeRecording(file: string): void {
  rmSync(file, { force: true });
}
