import { OtelExporter } from '@mastra/otel-exporter';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

/**
 * OpenTelemetry export, off unless OTEL_EXPORTER_OTLP_ENDPOINT is set. Two sources end up in the
 * same collector under one `service.name`:
 *
 * - Mastra's own spans (agent runs, model calls, tool calls, workflow steps) through
 *   `@mastra/otel-exporter`, added next to the storage exporter in the Observability config.
 * - Harness spans (propose, policy, decide, execute, write, verify) created with `@opentelemetry/api`
 *   in src/harness/tracing.ts, exported by the global tracer provider registered here.
 *
 * Both use OTLP over HTTP (`<endpoint>/v1/traces`). When the endpoint is unset nothing is registered
 * and the harness spans are the API's no-ops.
 */
export interface OtelSettings {
  endpoint: string;
  serviceName: string;
  headers: Record<string, string>;
}

export interface OtelEnv {
  OTEL_EXPORTER_OTLP_ENDPOINT?: string | undefined;
  OTEL_EXPORTER_OTLP_HEADERS?: string | undefined;
  OTEL_SERVICE_NAME: string;
}

/** `null` when export is off. */
export function otelSettings(env: OtelEnv): OtelSettings | null {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim().replace(/\/+$/, '');
  if (!endpoint) return null;
  return { endpoint, serviceName: env.OTEL_SERVICE_NAME, headers: parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS) };
}

/** `a=1,b=2` → `{ a: '1', b: '2' }` (the OTEL_EXPORTER_OTLP_HEADERS format; values may be URL-encoded). */
export function parseHeaders(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of (raw ?? '').split(',')) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    headers[pair.slice(0, at).trim()] = decodeURIComponent(pair.slice(at + 1).trim());
  }
  return headers;
}

/** Mastra exporter for the Observability config. Logs stay on stdout (the config has logging off). */
export function mastraOtelExporter(settings: OtelSettings): OtelExporter {
  return new OtelExporter({
    provider: { custom: { endpoint: settings.endpoint, protocol: 'http/json', headers: settings.headers } },
    signals: { logs: false },
  });
}

let provider: NodeTracerProvider | undefined;

/** Registers the global tracer provider for the harness spans. Idempotent. */
export function startHarnessTracing(settings: OtelSettings): void {
  if (provider) return;
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': settings.serviceName }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: `${settings.endpoint}/v1/traces`, headers: settings.headers }))],
  });
  provider.register();
}

/** Flushes and stops the harness provider (Mastra's exporter is flushed by `mastra.shutdown()`). */
export async function stopHarnessTracing(): Promise<void> {
  const current = provider;
  provider = undefined;
  await current?.shutdown();
}
