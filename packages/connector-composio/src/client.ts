/**
 * The connector's port onto Composio: execute one tool for our user / connected account, and read
 * tool definitions. `createComposioClient` backs it with `@composio/core`; tests can pass any
 * object with the same shape.
 */
import { Composio } from '@composio/core';
import type { ErrorClassifier } from '@ops/harness';

export interface ComposioToolResult {
  successful: boolean;
  data: unknown;
  error: string | null;
}

export interface ComposioToolInfo {
  slug: string;
  name: string;
  description: string;
  toolkit: string;
  /** JSON Schema of the tool's arguments, as Composio publishes it. */
  inputSchema: Record<string, unknown>;
}

/** What `ctx.connectors.<id>` must provide. */
export interface ComposioToolsClient {
  /** The Composio user id the connected accounts belong to (one per tenant, e.g. `golden-coast`). */
  readonly userId: string;
  execute(slug: string, args: Record<string, unknown>): Promise<ComposioToolResult>;
  /** Definitions of the given tools (unknown slugs are left out). */
  listTools(slugs: readonly string[]): Promise<ComposioToolInfo[]>;
}

/** A tool call Composio (or the provider behind it) refused or failed. */
export class ComposioToolError extends Error {
  override readonly name = 'ComposioToolError';
  constructor(
    readonly slug: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(`${slug}: ${message}`);
  }
}

const RETRYABLE = /\b(429|500|502|503|504)\b|rate.?limit|timed? ?out|ECONNRESET|ECONNREFUSED|fetch failed|socket hang up/i;

/** 429/5xx and network failures are retryable; validation, auth and "not found" are not. */
export function isRetryableComposioError(err: unknown): boolean {
  if (err instanceof ComposioToolError) return err.retryable;
  return err instanceof Error && RETRYABLE.test(`${err.name} ${err.message}`);
}

/** Harness `ErrorClassifier` for Composio tool calls. */
export const composioErrorClassifier: ErrorClassifier = { isRetryable: isRetryableComposioError };

/** Toolkit of a Composio tool slug (`GMAIL_SEND_EMAIL` → `gmail`). */
export function toolkitOfSlug(slug: string): string {
  const prefix = slug.split('_')[0] ?? '';
  return prefix.toLowerCase();
}

export interface ComposioClientConfig {
  /** Composio project API key (`ak_…`). */
  apiKey: string;
  /**
   * API origin. Omit for real Composio (`https://backend.composio.dev`); set to the emulator
   * (`http://localhost:4700`) locally.
   */
  baseURL?: string;
  userId: string;
  /** Pin a connected account per toolkit (`{ gmail: 'ca_…' }`); otherwise Composio picks the user's. */
  connectedAccountIds?: Partial<Record<string, string>>;
  /**
   * Toolkit versions to execute against (`{ gmail: '20251027_00' }`). Without them tools run at
   * `latest` with `dangerouslySkipVersionCheck` (fine for the emulator; pin them in production).
   */
  toolkitVersions?: Record<string, string>;
  /** An SDK instance to reuse (otherwise one is created). */
  composio?: Composio;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A `ComposioToolsClient` on `@composio/core`. */
export function createComposioClient(config: ComposioClientConfig): ComposioToolsClient & { sdk: Composio } {
  const sdk =
    config.composio ??
    new Composio({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      ...(config.toolkitVersions ? { toolkitVersions: config.toolkitVersions } : {}),
      allowTracking: false,
      disableVersionCheck: true,
    });
  const pinned = config.toolkitVersions !== undefined;

  return {
    sdk,
    userId: config.userId,
    async execute(slug, args) {
      const connectedAccountId = config.connectedAccountIds?.[toolkitOfSlug(slug)];
      let res: Awaited<ReturnType<typeof sdk.tools.execute>>;
      try {
        res = await sdk.tools.execute(slug, {
          userId: config.userId,
          ...(connectedAccountId ? { connectedAccountId } : {}),
          arguments: args,
          ...(pinned ? {} : { dangerouslySkipVersionCheck: true }),
        });
      } catch (err) {
        const message = err instanceof Error ? `${err.message}${isRecord(err.cause) && typeof err.cause.message === 'string' ? ` (${err.cause.message})` : ''}` : String(err);
        throw new ComposioToolError(slug, message, isRetryableComposioError(err));
      }
      return { successful: res.successful, data: res.data, error: res.error ?? null };
    },
    async listTools(slugs) {
      if (slugs.length === 0) return [];
      const list = await sdk.tools.getRawComposioTools({ tools: [...slugs] });
      return list.map((t) => ({
        slug: t.slug,
        name: t.name,
        description: t.description ?? '',
        toolkit: t.toolkit?.slug ?? toolkitOfSlug(t.slug),
        inputSchema: isRecord(t.inputParameters) ? t.inputParameters : { type: 'object', properties: {} },
      }));
    },
  };
}

/** Runs a tool and returns its data, throwing `ComposioToolError` when it did not succeed. */
export async function run(client: ComposioToolsClient, slug: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await client.execute(slug, args);
  if (!res.successful) {
    const message = res.error ?? 'tool call failed';
    throw new ComposioToolError(slug, message, RETRYABLE.test(message));
  }
  return res.data;
}
