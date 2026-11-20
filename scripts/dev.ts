// Starts the whole local stack with one command. On a fresh clone it also sets things up: env files (with a
// generated auth secret), Postgres and the Inngest dev server in Docker, the schema and the demo data. The
// only thing to add is ANTHROPIC_API_KEY in the root .env, and without it everything but the agents works.
// Ctrl+C stops everything.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';

const ROOT = `${import.meta.dir}/..`;
const step = (msg: string) => console.log(`\x1b[2m›\x1b[0m ${msg}`);

async function run(cmd: string[], cwd = ROOT) {
  const p = Bun.spawn(cmd, { cwd, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
  if ((await p.exited) !== 0) {
    console.error(`\n✗ ${cmd.join(' ')} failed`);
    process.exit(1);
  }
}

// 1. Env files. Bun has already loaded the root .env into process.env, so the key reaches every app from there.
if (!existsSync(`${ROOT}/.env`)) {
  await Bun.write(`${ROOT}/.env`, await Bun.file(`${ROOT}/.env.example`).text());
  step('created .env: put your ANTHROPIC_API_KEY in it to run the agents');
}
const agentEnv = `${ROOT}/apps/agent/.env`;
if (!existsSync(agentEnv)) {
  const example = await Bun.file(`${ROOT}/apps/agent/.env.example`).text();
  const secret = randomBytes(32).toString('base64');
  await Bun.write(agentEnv, example.replace(/^BETTER_AUTH_SECRET=.*$/m, `BETTER_AUTH_SECRET=${secret}`));
  step('created apps/agent/.env with a generated auth secret');
}
const webEnv = `${ROOT}/apps/web/.env`;
if (!existsSync(webEnv)) await Bun.write(webEnv, await Bun.file(`${ROOT}/apps/web/.env.example`).text());

// 2. Dependencies, Postgres and Inngest.
if (!existsSync(`${ROOT}/node_modules`)) {
  step('installing dependencies');
  await run(['bun', 'install']);
}
step('starting Postgres and the Inngest dev server (Docker)');
await run(['docker', 'compose', '--profile', 'dev', 'up', '-d', '--wait', 'postgres', 'inngest']);

// 3. Schema and demo data. Both are idempotent, so this is quick after the first run.
step('database schema and demo data');
await run(['bun', 'run', 'db:push'], `${ROOT}/apps/agent`);
await run(['bun', 'run', 'db:seed'], `${ROOT}/apps/agent`);
await run(['bun', 'run', 'db:seed:history'], `${ROOT}/apps/agent`);

// An empty key in the root .env mustn't mask one set in apps/agent/.env (a set variable wins over .env files).
const rootKey = process.env.ANTHROPIC_API_KEY;
if (!rootKey) delete process.env.ANTHROPIC_API_KEY;
const hasKey = Boolean(rootKey) || /^ANTHROPIC_API_KEY=\S+/m.test(await Bun.file(agentEnv).text());

// 4. Every app's `dev` script: agent, web, Distru mock, Headset mock, emulators.
const apps = Bun.spawn(['bun', 'run', '--filter', './apps/*', 'dev'], { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' });

const stop = () => {
  apps.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const keyNote = hasKey
  ? ''
  : '\n  ⚠ ANTHROPIC_API_KEY is not set in .env: the dashboard works, but agent runs and the Copilot will fail.\n';
console.log(`
  Ops Agent is starting:
    dashboard        http://localhost:3050   (sign in as Operator or Approver)
    agent server     http://localhost:4111
    Inngest          http://localhost:8288
    Distru mock      http://localhost:4500
    Headset mock     http://localhost:4600
    emulators        http://localhost:4700
${keyNote}
  Postgres and Inngest keep running in Docker after Ctrl+C; \`docker compose --profile dev down\` stops them.
`);

await apps.exited;
