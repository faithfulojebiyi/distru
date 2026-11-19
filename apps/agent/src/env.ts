import { z } from 'zod';

/**
 * Environment contract for the agent server. Parsed once at boot; the process exits with a readable
 * error if anything required is missing. Optional keys (ANTHROPIC_API_KEY, Inngest keys) let the
 * server boot locally without them.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4111),
  DATABASE_URL: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
  BETTER_AUTH_URL: z.url().default('http://localhost:4111'),
  /** Comma-separated list of browser origins allowed to call the API with credentials. */
  WEB_ORIGIN: z
    .string()
    .default('http://localhost:3050')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  /** Standalone Mastra Studio origin(s), allowed by CORS in development only (never in production). */
  STUDIO_ORIGIN: z
    .string()
    .default('http://localhost:3000')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Default model (Mastra model router id) for every agent; each agent can override it below. */
  OPS_AGENT_MODEL: z.string().default('anthropic/claude-sonnet-5-5'),
  OPS_LEAD_MODEL: z.string().optional(),
  INVENTORY_ANALYST_MODEL: z.string().optional(),
  PROCUREMENT_PLANNER_MODEL: z.string().optional(),
  COMPLIANCE_REVIEWER_MODEL: z.string().optional(),
  POLICY_CRITIC_MODEL: z.string().optional(),
  /** Cost estimate for run budgets/timelines (USD per million tokens). Not billing data. */
  LLM_INPUT_USD_PER_MTOK: z.coerce.number().nonnegative().default(3),
  LLM_OUTPUT_USD_PER_MTOK: z.coerce.number().nonnegative().default(15),
  DISTRU_BASE_URL: z.url().default('http://localhost:4500/public/v1'),
  DISTRU_API_TOKEN: z.string().default('mock-token'),
  /**
   * Distru MCP server for the `distru_mcp` bridge connector (writes such as the allocation guard's
   * per-buyer menu cap). Empty string disables the connector. Default: the local mock's /mcp.
   */
  DISTRU_MCP_URL: z.union([z.url(), z.literal('')]).default('http://localhost:4500/mcp'),
  /** `distru_mcp_…` key (the mock accepts any `distru_mcp_` key). */
  DISTRU_MCP_KEY: z.string().min(1).default('distru_mcp_mock'),
  /** How often the MCP bridge re-lists tools (and reconnects while the server is down), in ms. */
  DISTRU_MCP_REFRESH_MS: z.coerce.number().int().min(1000).default(60_000),
  /** Retail sell-through analytics (Headset-style mock by default). */
  HEADSET_BASE_URL: z.url().default('http://localhost:4600'),
  HEADSET_API_TOKEN: z.string().min(1).default('headset-mock-token'),
  /** Set to send vendor email through Resend; unset = in-memory mock outbox (nothing leaves the process). */
  RESEND_API_KEY: z.string().optional(),
  /** Sender for vendor email (required with RESEND_API_KEY). */
  EMAIL_FROM: z.string().min(3).optional(),
  /** Role of the Distru user who gets the "Receive PO-… on <date>" hand-off task. */
  RESTOCK_TASK_OWNER_ROLE: z.string().min(1).default('Purchasing Manager'),
  /** HMAC secret for `x-distru-signature` on POST /api/webhooks/distru (the mock's default in dev). */
  DISTRU_WEBHOOK_SECRET: z.string().min(1).optional(),
  /** `1` registers the morning restock cron (Inngest). Off by default. */
  RESTOCK_CRON_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === '1' || v === 'true'),
  /** Inngest cron expression; `TZ=` prefix supported by Inngest (e.g. `TZ=America/Los_Angeles 0 7 * * *`). */
  RESTOCK_CRON: z.string().default('TZ=America/Los_Angeles 0 7 * * *'),
  INNGEST_DEV: z.string().optional(),
  INNGEST_EVENT_KEY: z.string().optional(),
  INNGEST_SIGNING_KEY: z.string().optional(),
});

export type Env = Omit<z.infer<typeof EnvSchema>, 'DISTRU_WEBHOOK_SECRET'> & { DISTRU_WEBHOOK_SECRET: string };

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment configuration:\n' + z.prettifyError(parsed.error));
    process.exit(1);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production' && env.INNGEST_DEV) {
    console.error('INNGEST_DEV must not be set in production (it disables signature verification).');
    process.exit(1);
  }
  if (env.NODE_ENV === 'production' && (!env.INNGEST_EVENT_KEY || !env.INNGEST_SIGNING_KEY)) {
    console.error('INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY are required in production.');
    process.exit(1);
  }
  if (env.RESEND_API_KEY && !env.EMAIL_FROM) {
    console.error('EMAIL_FROM is required when RESEND_API_KEY is set.');
    process.exit(1);
  }
  if (env.NODE_ENV === 'production' && !env.DISTRU_WEBHOOK_SECRET) {
    console.error('DISTRU_WEBHOOK_SECRET is required in production.');
    process.exit(1);
  }
  return { ...env, DISTRU_WEBHOOK_SECRET: env.DISTRU_WEBHOOK_SECRET ?? 'mock-webhook-secret' };
}

export const env = loadEnv();
