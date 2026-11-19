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
  ANTHROPIC_API_KEY: z.string().optional(),
  OPS_AGENT_MODEL: z.string().default('anthropic/claude-sonnet-5-5'),
  DISTRU_BASE_URL: z.url().default('http://localhost:4500/public/v1'),
  DISTRU_API_TOKEN: z.string().default('mock-token'),
  INNGEST_DEV: z.string().optional(),
  INNGEST_EVENT_KEY: z.string().optional(),
  INNGEST_SIGNING_KEY: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

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
  return env;
}

export const env = loadEnv();
