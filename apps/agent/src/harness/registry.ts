import { emailConnector, emailErrorClassifier, createEmailContext, OutboxTransport, ResendTransport, type EmailCtx } from '@ops/connector-email';
import { createDistruContext, distruConnector, distruErrorClassifier, type DistruCtx } from '@ops/connector-distru';
import { createHeadsetContext, headsetConnector, type HeadsetCtx } from '@ops/connector-headset';
import { createDistruMcpConnector, mcpErrorClassifier, McpBridgeClient, type BridgedTool, type McpBridge, type McpCtx } from '@ops/connector-mcp';
import type { FetchLike } from '@ops/distru-client';
import {
  composioConfigFromEnv,
  composioErrorClassifier,
  ComposioToolError,
  createComposioConnector,
  type ComposioBridge,
  type ComposioCtx,
  type ComposioToolsClient,
} from '@ops/connector-composio';
import { contextConnector, createRecall, HashEmbedder, InMemoryContextStore, InMemoryRecallStore, InMemoryRecallVectorIndex, recallConnector, type ContextCtx, type ContextService, type RecallCtx, type RecallService } from '@ops/context';
import { Registry, routeErrorClassifier, type AnyTrigger, type ConnectorDefinition, type ErrorClassifier } from '@ops/harness';
import { db } from '../db/client';
import { env } from '../env';
import { DrizzleSentEmailRecord } from './email-record';
import { appContextStore, appRecall } from '../context';
import { appTriggers } from './triggers';

/**
 * The app's connectors and action registry.
 *
 * | id           | system    | what                                                                  |
 * |--------------|-----------|-----------------------------------------------------------------------|
 * | `distru`     | erp       | REST: velocity, stock, vendors, POs (`purchases.upsert`), hand-off tasks (`tasks.create`) |
 * | `headset`    | analytics | retail sell-through (read-only): `retail_trends`, `demand_signal`, …  |
 * | `email`      | email     | `send_vendor_po` (high risk, always a human); mock outbox or Resend   |
 * | `distru_mcp` | erp       | Distru's MCP server through the generic bridge (`mutate_product` = per-buyer menu cap, …) |
 * | `composio`   | other     | Gmail / Calendar via Composio (emulator locally): thread reads, `gmail_reply_to_thread`, … + the Gmail new-message trigger |
 * | `context`    | analytics | account profile, learned memories, unified query (read-only)          |
 * | `recall`     | other     | semantic search over vendor email, vendor replies and PO notes (`recall_search`; read-only; RECALL_ENABLED) |
 *
 * Triggers: `distru.order_created` (Distru connector), `composio.gmail.new_message` (Composio
 * connector), and the app-level `slack.interaction` + `schedule.morning_restock` (`./triggers`).
 *
 * `composio` has the same degraded mode as `distru_mcp`: if Composio (the emulator) is down at boot
 * the app starts without it and retries every COMPOSIO_REFRESH_MS; once it connects the registry is
 * rebuilt. Its context client throws a retryable "unavailable" error until then.
 *
 * `distru_mcp` is built from a live `tools/list`, so the registry is built **asynchronously at
 * boot** (`AppConnectors.start`) with a degraded mode: if the MCP server is unreachable the app
 * starts without it, `GET /api/connectors` reports it unhealthy, and a timer keeps retrying. Every
 * refresh re-lists tools and **rebuilds the registry** (registries copy connectors). Once registered
 * the connector is never dropped because the server is briefly down (pending proposals may reference
 * its actions); its health probe reports the outage instead.
 *
 * The harness reads the registry through a getter (`createHarness({ registry: () => … })`) and the
 * agents resolve their tools per call, so a rebuilt registry is picked up without a restart.
 */

export const DISTRU_MCP_ID = 'distru_mcp';
export type DistruMcpCtx = McpCtx<typeof DISTRU_MCP_ID>;

/** Everything the registry's hooks need, plus the tenant and run context this process serves. */
export const COMPOSIO_ID = 'composio';
export type AppComposioCtx = ComposioCtx<typeof COMPOSIO_ID>;

export type AppCtx = DistruCtx & HeadsetCtx & EmailCtx & DistruMcpCtx & AppComposioCtx & ContextCtx & RecallCtx & {
  tenantId: string;
  /** `intent` etc. for MCP servers that require them (Distru); see connector-mcp `runContextOf`. */
  run?: { intent?: string; userSatisfactionEstimate?: number };
};

export type DistruMcpConnector = ConnectorDefinition<DistruMcpCtx>;
export type AppComposioConnector = ConnectorDefinition<AppComposioCtx>;

/**
 * Builds the registry from the static connectors plus the MCP bridge / Composio connectors when
 * available, and the app-level triggers (Slack interactions, the morning schedule).
 */
export function buildAppRegistry(
  mcp: DistruMcpConnector | null,
  composio: AppComposioConnector | null = null,
  triggers: readonly AnyTrigger[] = appTriggers(),
  opts: { recall?: boolean } = {},
): Registry<AppCtx> {
  return new Registry<AppCtx>({
    // `context` (read-only): account profile, learned memories, unified query (packages/context).
    // `recall` (read-only): semantic search over unstructured history, when enabled.
    connectors: [distruConnector, headsetConnector, emailConnector, contextConnector, ...(opts.recall ? [recallConnector] : []), ...(mcp ? [mcp] : []), ...(composio ? [composio] : [])],
    triggers,
  });
}

/**
 * Error classification routed by the failing op's connector: Distru REST 429/5xx (+ Retry-After),
 * MCP endpoint 429/5xx, Resend 429/5xx (+ Retry-After). Headset has no writes.
 */
export const appErrorClassifier: ErrorClassifier = routeErrorClassifier({
  distru: distruErrorClassifier,
  email: emailErrorClassifier,
  [DISTRU_MCP_ID]: mcpErrorClassifier,
  [COMPOSIO_ID]: composioErrorClassifier,
});

/** `connected` / `unavailable` (down or never reached; retried) / `disabled` (not configured). */
export interface ComposioStatus {
  state: 'connected' | 'unavailable' | 'disabled';
  registered: boolean;
  detail: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
}

/** The context client while Composio is not connected: every call fails (retryable) with a clear reason. */
export function unavailableComposioClient(userId: string, reason = 'Composio is unavailable (degraded mode)'): ComposioToolsClient {
  return {
    userId,
    execute: async (slug) => {
      throw new ComposioToolError(slug, reason, true);
    },
    listTools: async () => [],
  };
}

export interface McpStatus {
  /** `connected`: registered and the last refresh worked; `unavailable`: down (or never reached); `disabled`: no URL configured. */
  state: 'connected' | 'unavailable' | 'disabled';
  /** Registered in the current registry (true even while temporarily unavailable after a successful boot). */
  registered: boolean;
  detail: string;
  url: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  tools: number;
}

export interface AppConnectorsOptions {
  /** Connects to the MCP server and builds the bridge; null disables `distru_mcp`. */
  connectMcp: (() => Promise<McpBridge<typeof DISTRU_MCP_ID>>) | null;
  /** Used for the context while the bridge is not up (calls fail; nothing references its actions). */
  mcpUrl?: string | null;
  refreshMs?: number;
  /** Logger for boot / refresh outcomes. */
  log?: (level: 'info' | 'warn', message: string) => void;
  /** Connects to Composio and builds its connector; null/absent disables `composio`. */
  connectComposio?: (() => Promise<ComposioBridge<typeof COMPOSIO_ID>>) | null;
  /** Composio user id for the placeholder client while it is down. */
  composioUserId?: string;
  /** Register the `recall` connector (semantic search; `recall_search` for the Ops Lead, Planner, Vendor Liaison). */
  recall?: boolean;
}

export interface RefreshResult {
  changed: boolean;
  status: McpStatus;
  added: string[];
  removed: string[];
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Holds the current registry and the MCP bridge; see the module comment for the degraded mode. */
export class AppConnectors {
  #registry: Registry<AppCtx>;
  #bridge: McpBridge<typeof DISTRU_MCP_ID> | null = null;
  #mcpConnector: DistruMcpConnector | null = null;
  #composio: ComposioBridge<typeof COMPOSIO_ID> | null = null;
  #composioFallback: ComposioToolsClient;
  #composioStatus: ComposioStatus;
  #fallback: McpBridgeClient;
  #timer: ReturnType<typeof setInterval> | null = null;
  #refreshing: Promise<RefreshResult> | null = null;
  #status: McpStatus;
  readonly #options: AppConnectorsOptions;

  constructor(options: AppConnectorsOptions) {
    this.#options = options;
    this.#registry = buildAppRegistry(null, null, appTriggers(), { recall: options.recall ?? false });
    const url = options.mcpUrl ?? null;
    this.#fallback = new McpBridgeClient({ url: url ?? 'http://127.0.0.1:9/mcp-disabled' });
    this.#status = {
      state: options.connectMcp ? 'unavailable' : 'disabled',
      registered: false,
      detail: options.connectMcp ? 'not connected yet' : 'disabled (DISTRU_MCP_URL is empty)',
      url,
      lastAttemptAt: null,
      lastSuccessAt: null,
      tools: 0,
    };
    this.#composioFallback = unavailableComposioClient(options.composioUserId ?? 'golden-coast');
    this.#composioStatus = {
      state: options.connectComposio ? 'unavailable' : 'disabled',
      registered: false,
      detail: options.connectComposio ? 'not connected yet' : 'disabled (COMPOSIO_API_KEY is empty)',
      lastAttemptAt: null,
      lastSuccessAt: null,
    };
  }

  get composioStatus(): ComposioStatus {
    return { ...this.#composioStatus };
  }

  /** The Composio client for `ctx.connectors.composio` (a failing placeholder while it is down). */
  composioClient(): ComposioToolsClient {
    return this.#composio?.client ?? this.#composioFallback;
  }

  #rebuild(): void {
    this.#registry = buildAppRegistry(this.#mcpConnector, this.#composio?.connector ?? null, appTriggers(), { recall: this.#options.recall ?? false });
  }

  /** Connect Composio once (its tool list is static); never throws. Returns true when the registry changed. */
  async #refreshComposio(): Promise<boolean> {
    const connect = this.#options.connectComposio;
    if (!connect || this.#composio) return false;
    const now = new Date().toISOString();
    this.#composioStatus.lastAttemptAt = now;
    try {
      this.#composio = await connect();
      const writes = this.#composio.tools.filter((t) => t.kind === 'write').length;
      this.#composioStatus = { ...this.#composioStatus, state: 'connected', registered: true, lastSuccessAt: now, detail: `${this.#composio.tools.length} tools (${this.#composio.tools.length - writes} read, ${writes} write)` };
      this.#rebuild();
      this.#options.log?.('info', `composio connected: ${this.#composioStatus.detail}`);
      return true;
    } catch (err) {
      const first = !this.#composioStatus.lastSuccessAt && this.#composioStatus.detail === 'not connected yet';
      this.#composioStatus.state = 'unavailable';
      this.#composioStatus.detail = `unreachable: ${errorMessage(err)}${this.#options.refreshMs ? ` (retrying every ${Math.round(this.#options.refreshMs / 1000)}s)` : ''}`;
      if (first) this.#options.log?.('warn', `composio ${this.#composioStatus.detail}`);
      return false;
    }
  }

  /** The current registry (rebuilt when the MCP connector appears or its tool list changes). */
  get registry(): Registry<AppCtx> {
    return this.#registry;
  }

  get mcpStatus(): McpStatus {
    return { ...this.#status };
  }

  /** The bridged Distru MCP tools with their classification (`reaches`, risk); empty while the bridge is down. */
  bridgedTools(): BridgedTool[] {
    return this.#bridge?.tools ?? [];
  }

  /** The MCP client for `ctx.connectors.distru_mcp` (a never-connected placeholder while the bridge is down). */
  mcpClient(): McpBridgeClient {
    return this.#bridge?.client ?? this.#fallback;
  }

  /** First connection attempt (never throws) + the periodic refresh timer. */
  async start(): Promise<McpStatus> {
    await this.refresh();
    const every = this.#options.refreshMs ?? 0;
    if (every > 0 && (this.#options.connectMcp || this.#options.connectComposio) && !this.#timer) {
      this.#timer = setInterval(() => void this.refresh(), every);
      // Never keep the process alive just for the refresh loop.
      (this.#timer as { unref?: () => void }).unref?.();
    }
    return this.mcpStatus;
  }

  /** Connect (if not connected) or re-list tools; rebuilds the registry when the connector changed. Never throws. */
  refresh(): Promise<RefreshResult> {
    this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  async #refresh(): Promise<RefreshResult> {
    const composioChanged = await this.#refreshComposio();
    const r = await this.#refreshMcp();
    return composioChanged ? { ...r, changed: true } : r;
  }

  async #refreshMcp(): Promise<RefreshResult> {
    const connect = this.#options.connectMcp;
    if (!connect) return { changed: false, status: this.mcpStatus, added: [], removed: [] };
    const now = new Date().toISOString();
    this.#status.lastAttemptAt = now;
    try {
      if (!this.#bridge) {
        const bridge = await connect();
        this.#bridge = bridge;
        this.#mcpConnector = bridge.connector;
        this.#rebuild();
        this.#ok(now, bridge.tools.length);
        this.#options.log?.('info', `distru_mcp connected: ${this.#status.detail}`);
        return { changed: true, status: this.mcpStatus, added: bridge.tools.map((t) => t.tool), removed: [] };
      }
      const r = await this.#bridge.refresh();
      const changed = r.added.length + r.removed.length + r.reclassified.length > 0;
      if (changed) {
        this.#mcpConnector = r.connector;
        this.#rebuild();
        this.#options.log?.('info', `distru_mcp tools changed (+${r.added.length} −${r.removed.length} ~${r.reclassified.length}); registry rebuilt`);
      }
      this.#ok(now, r.tools.length);
      return { changed, status: this.mcpStatus, added: r.added, removed: r.removed };
    } catch (err) {
      const wasUp = this.#status.state === 'connected';
      this.#status.state = 'unavailable';
      this.#status.detail = `unreachable: ${errorMessage(err)}${this.#options.refreshMs ? ` (retrying every ${Math.round(this.#options.refreshMs / 1000)}s)` : ''}`;
      if (wasUp || !this.#status.lastSuccessAt) this.#options.log?.('warn', `distru_mcp ${this.#status.detail}`);
      return { changed: false, status: this.mcpStatus, added: [], removed: [] };
    }
  }

  #ok(now: string, tools: number): void {
    const writes = this.#bridge?.tools.filter((t) => t.kind === 'write').length ?? 0;
    this.#status = { ...this.#status, state: 'connected', registered: true, lastSuccessAt: now, tools, detail: `${tools} tools (${tools - writes} read, ${writes} write)` };
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#bridge?.close().catch(() => undefined);
  }
}

// ── contexts ─────────────────────────────────────────────────────────────────────────────────

export interface AppContexts {
  /** Reads and planning (propose/edit): the Distru client retries 429/5xx itself. */
  read: AppCtx;
  /**
   * `harness.execute`: `maxRetries: 0`, so a 429/5xx reaches the harness, which retries with
   * `appErrorClassifier` (honouring Retry-After) and audits each attempt (`op.retry`).
   */
  execute: AppCtx;
}

export interface AppContextConfig {
  baseUrl: string;
  token: string;
  tenantId?: string;
  /** Injected in tests (e.g. the in-process Distru mock). */
  fetch?: FetchLike;
  headset?: { baseUrl: string; token: string; fetch?: FetchLike };
  /** Shared by read and execute contexts (verify reads the outbox back). Default: a fresh mock outbox. */
  email?: EmailCtx['connectors']['email'];
  /** The MCP client, resolved on every access so a reconnected bridge is picked up. */
  mcpClient: () => McpBridgeClient;
  /** The Composio client, resolved on every access (default: an "unavailable" placeholder). */
  composioClient?: () => ComposioToolsClient;
  /** The context layer (default: an empty in-memory store). */
  context?: ContextService;
  /** Semantic recall (default: an empty in-memory index; only reachable when the connector is registered). */
  recall?: RecallService;
}

/** An empty, dependency-free recall service (lexical embedder, in-memory index). */
export const emptyRecallService = (): RecallService => createRecall({ index: new InMemoryRecallVectorIndex(), store: new InMemoryRecallStore(), embedder: new HashEmbedder() }).service;

export function buildAppContexts(config: AppContextConfig): AppContexts {
  const { baseUrl, token, fetch } = config;
  const tenantId = config.tenantId ?? 'default';
  const base = { baseUrl, token, ...(fetch ? { fetch } : {}) };
  const headset = createHeadsetContext({
    baseUrl: config.headset?.baseUrl ?? env.HEADSET_BASE_URL,
    token: config.headset?.token ?? env.HEADSET_API_TOKEN,
    ...(config.headset?.fetch ? { fetch: config.headset.fetch } : {}),
  }).connectors.headset;
  const email = config.email ?? createEmailContext().connectors.email;
  const fallbackComposio = unavailableComposioClient(env.COMPOSIO_USER_ID, 'Composio is not configured');
  const composioClient = config.composioClient ?? (() => fallbackComposio);
  const context: ContextService = config.context ?? { store: new InMemoryContextStore() };
  const recall: RecallService = config.recall ?? emptyRecallService();
  const ctx = (distru: DistruCtx['connectors']['distru']): AppCtx => ({
    connectors: {
      distru,
      headset,
      email,
      get [DISTRU_MCP_ID]() {
        return config.mcpClient();
      },
      get [COMPOSIO_ID]() {
        return composioClient();
      },
      context,
      recall,
    },
    tenantId,
    run: { intent: 'Ops Agent restock: governed write approved by a human' },
  });
  return {
    read: ctx(createDistruContext(base).connectors.distru),
    execute: ctx(createDistruContext({ ...base, maxRetries: 0 }).connectors.distru),
  };
}

// ── process-wide singletons ──────────────────────────────────────────────────────────────────

/**
 * Email from env: Resend when RESEND_API_KEY is set, else the mock outbox. Either way sent messages are
 * recorded in Postgres (`email_sent`), so the outbox and the executor's dedupe survive restarts.
 */
function emailFromEnv(): EmailCtx['connectors']['email'] {
  if (env.RESEND_API_KEY) return { transport: new ResendTransport({ apiKey: env.RESEND_API_KEY, record: new DrizzleSentEmailRecord(db, 'resend') }), from: env.EMAIL_FROM! };
  return { transport: new OutboxTransport({ record: new DrizzleSentEmailRecord(db, 'outbox') }), from: env.EMAIL_FROM ?? 'Golden Coast Purchasing <purchasing@goldencoastdistro.com>' };
}

export const appConnectors = new AppConnectors({
  connectMcp: env.DISTRU_MCP_URL ? () => createDistruMcpConnector({ url: env.DISTRU_MCP_URL, key: env.DISTRU_MCP_KEY }) : null,
  mcpUrl: env.DISTRU_MCP_URL || null,
  refreshMs: Math.min(env.DISTRU_MCP_REFRESH_MS, env.COMPOSIO_REFRESH_MS),
  log: (level, message) => (level === 'warn' ? console.warn(message) : console.log(message)),
  connectComposio: env.COMPOSIO_API_KEY
    ? () =>
        createComposioConnector({
          ...composioConfigFromEnv({ ...process.env, COMPOSIO_API_KEY: env.COMPOSIO_API_KEY, COMPOSIO_BASE_URL: env.COMPOSIO_BASE_URL, COMPOSIO_USER_ID: env.COMPOSIO_USER_ID, COMPOSIO_TOOLKITS: env.COMPOSIO_TOOLKITS }),
          id: COMPOSIO_ID,
        })
    : null,
  composioUserId: env.COMPOSIO_USER_ID,
  recall: env.RECALL_ENABLED,
});

let contexts: AppContexts | null = null;

/** Process-wide contexts from DISTRU_BASE_URL / DISTRU_API_TOKEN, HEADSET_*, email env (local mocks by default). */
export function appContexts(): AppContexts {
  contexts ??= buildAppContexts({
    baseUrl: env.DISTRU_BASE_URL,
    token: env.DISTRU_API_TOKEN,
    email: emailFromEnv(),
    mcpClient: () => appConnectors.mcpClient(),
    composioClient: () => appConnectors.composioClient(),
    context: { store: appContextStore },
    recall: appRecall.service,
  });
  return contexts;
}

/** Context for reads, propose and decide (edits re-plan). */
export function createAppCtx(): AppCtx {
  return appContexts().read;
}
