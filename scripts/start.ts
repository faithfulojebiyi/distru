// Production launcher for the single-container demo (see Dockerfile). Prepares the database, then runs the
// Distru and Headset mocks, the emulators, a self-hosted Inngest server, the agent and the web app side by
// side, with a small proxy on $PORT so the browser sees one origin: agent routes go to the agent, everything
// else to the dashboard. If any process exits, the container exits and the platform restarts it.
import { randomBytes } from 'node:crypto';

const env = process.env;
const PORT = Number(env.PORT ?? 8080);
const PUBLIC_URL = (env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '');
if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!env.BETTER_AUTH_SECRET) throw new Error('BETTER_AUTH_SECRET is required (openssl rand -base64 32)');

// Secrets shared only between processes in this container (webhooks from the mocks and emulators to the
// agent, Inngest to the agent). Generated per boot unless provided.
const secret = (name: string, make: () => string) => env[name] || make();
const hex = () => randomBytes(32).toString('hex');
const shared = {
  DISTRU_WEBHOOK_SECRET: secret('DISTRU_WEBHOOK_SECRET', hex),
  COMPOSIO_WEBHOOK_SECRET: secret('COMPOSIO_WEBHOOK_SECRET', () => `whsec_${hex()}`),
  SLACK_SIGNING_SECRET: secret('SLACK_SIGNING_SECRET', hex),
  INNGEST_EVENT_KEY: secret('INNGEST_EVENT_KEY', hex),
  INNGEST_SIGNING_KEY: secret('INNGEST_SIGNING_KEY', hex),
};

const AGENT = 'http://127.0.0.1:4111';
const WEB = 'http://127.0.0.1:3050';
const INNGEST = 'http://127.0.0.1:8288';

const base = { ...env, NODE_ENV: 'production' } as Record<string, string>;
delete base.PORT;
delete base.INNGEST_DEV;
// What the agent (and the seed script, which loads the agent's env) needs.
const agentEnv = { ...shared, BETTER_AUTH_URL: PUBLIC_URL, WEB_ORIGIN: PUBLIC_URL, WEB_BASE_URL: PUBLIC_URL, PUBLIC_URL, INNGEST_BASE_URL: INNGEST };

async function run(cmd: string[], cwd: string, extra: Record<string, string> = {}) {
  const p = Bun.spawn(cmd, { cwd, env: { ...base, ...extra }, stdout: 'inherit', stderr: 'inherit' });
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(' ')} failed`);
}

console.log('[start] preparing the database');
await run(['bun', 'scripts/db-extensions.ts'], 'apps/agent');
await run(['bunx', 'drizzle-kit', 'push', '--force'], 'apps/agent');
await run(['bun', 'src/db/seed.ts'], 'apps/agent', agentEnv);

const services: Array<[string, string[], string, Record<string, string>]> = [
  ['distru-mock', ['bun', 'src/index.ts'], 'apps/distru-mock', { PORT: '4500', WEBHOOK_SECRET: shared.DISTRU_WEBHOOK_SECRET }],
  ['headset-mock', ['bun', 'src/index.ts'], 'apps/headset-mock', { PORT: '4600' }],
  [
    'emulators',
    ['bun', 'src/index.ts'],
    'apps/emulators',
    { PORT: '4700', COMPOSIO_WEBHOOK_SECRET: shared.COMPOSIO_WEBHOOK_SECRET, SLACK_SIGNING_SECRET: shared.SLACK_SIGNING_SECRET },
  ],
  [
    'agent',
    ['bun', 'src/index.ts'],
    'apps/agent',
    { ...agentEnv, PORT: '4111' },
  ],
  [
    'inngest',
    [
      'inngest', 'start', '--port', '8288', '-u', `${AGENT}/api/inngest`,
      '--event-key', shared.INNGEST_EVENT_KEY, '--signing-key', shared.INNGEST_SIGNING_KEY,
    ],
    '/tmp',
    {},
  ],
  ['web', ['bun', 'serve.ts'], 'apps/web', { PORT: '3050', HOST: '127.0.0.1' }],
];

const procs = services.map(([name, cmd, cwd, extra]) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...base, ...extra }, stdout: 'inherit', stderr: 'inherit' });
  p.exited.then((code) => {
    console.error(`[start] ${name} exited (${code}); stopping the container`);
    stop(1);
  });
  return p;
});

function stop(code = 0) {
  for (const p of procs) p.kill();
  process.exit(code);
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

// Agent routes: the API (auth, Inngest, webhooks, A2A cards included) and the MCP server.
const toAgent = (path: string) => path.startsWith('/api/') || path === '/mcp';

Bun.serve({
  port: PORT,
  idleTimeout: 255, // agent streams and MCP sessions stay open for a while
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === '/healthz') return new Response('ok');
    const target = (toAgent(url.pathname) ? AGENT : WEB) + url.pathname + url.search;
    const headers = new Headers(req.headers);
    // Overwrite, never append: the agent rate-limits sign-in by this header, so clients mustn't set it.
    const clientIp = req.headers.get('fly-client-ip') ?? server.requestIP(req)?.address ?? '';
    headers.set('x-forwarded-for', clientIp);
    headers.delete('x-real-ip');
    headers.set('x-forwarded-host', url.host);
    headers.set('x-forwarded-proto', new URL(PUBLIC_URL).protocol.replace(':', ''));
    try {
      return await fetch(target, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
        redirect: 'manual',
        decompress: false, // pass compressed bodies through with their content-encoding
        // @ts-expect-error bun supports streaming request bodies
        duplex: 'half',
      });
    } catch {
      return new Response('Starting up, try again in a few seconds.', { status: 503 });
    }
  },
});

console.log(`[start] Ops Agent on ${PUBLIC_URL} (proxy :${PORT})`);
