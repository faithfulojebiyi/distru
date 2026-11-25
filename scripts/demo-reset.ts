// Puts the running local stack into a clean "ready to show" state, for a live demo:
//
//   1. clears demo activity (proposals, runs, traces, Slack and email records), keeping the seeded history
//   2. resets the Distru mock and the emulators to their seed data
//   3. runs a restock for one warehouse and approves it, so there's an executed proposal with its audit trail
//   4. has that vendor reply with a partial shipment, so the vendor-reply loop leaves a proposal waiting
//   5. starts a restock for a second warehouse and leaves it waiting for approval
//
// Needs `bun run dev` running with ANTHROPIC_API_KEY set. Takes a few minutes and about $1–2 of model calls.
//
//   bun run demo:reset            # all of the above
//   bun run demo:reset --clean    # steps 1–2 only
const AGENT = 'http://localhost:4111';
const MOCK = 'http://localhost:4500';
const EMU = 'http://localhost:4700';
const ORIGIN = 'http://localhost:3050';
const FIRST = 'Oakland Warehouse';
const SECOND = 'Los Angeles Distribution Center';
const cleanOnly = process.argv.includes('--clean');

type Json = Record<string, any>;
const step = (msg: string) => console.log(`\x1b[2m›\x1b[0m ${msg}`);
const fail = (msg: string): never => {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
};

async function up(url: string) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}
for (const [name, url] of [['agent server', `${AGENT}/api/health`], ['Distru mock', `${MOCK}/__mock/state`], ['emulators', `${EMU}/__emu/state`]]) {
  if (!(await up(url))) fail(`${name} isn't reachable at ${url}. Start the stack with \`bun run dev\` first.`);
}

// 1. Demo activity. The seeded history (meta.seed = 'history') stays, so memories still have something to show.
const envFile = await Bun.file(`${import.meta.dir}/../apps/agent/.env`).text().catch(() => '');
const dbUrl = process.env.DATABASE_URL ?? /^DATABASE_URL=(.+)$/m.exec(envFile)?.[1]?.trim() ?? 'postgres://ops:ops@127.0.0.1:5482/ops';
const sql = new Bun.SQL(dbUrl);
step('clearing demo activity (keeping seeded history)');
await sql.begin(async (tx) => {
  const gone = await tx`DELETE FROM proposal WHERE meta->>'seed' IS DISTINCT FROM 'history' RETURNING id`;
  await tx`DELETE FROM audit_event WHERE proposal_id IS NOT NULL AND proposal_id NOT IN (SELECT id FROM proposal)`;
  await tx`DELETE FROM slack_message WHERE proposal_id NOT IN (SELECT id FROM proposal)`;
  await tx`DELETE FROM email_sent`;
  for (const table of ['mastra_workflow_snapshot', 'mastra_workflow_runs', 'mastra_workflow_run_entries', 'mastra_workflow_run_owners', 'mastra_ai_spans']) {
    await tx.unsafe(`DELETE FROM mastra.${table}`).catch(() => {}); // not every Mastra version has every table
  }
  console.log(`  removed ${gone.length} proposals and their runs`);
});
await sql.close();

// 2. Seed data in the mock and the emulators.
step('resetting the Distru mock and the emulators');
for (const url of [`${MOCK}/__mock/reset`, `${EMU}/__emu/reset`]) {
  const res = await fetch(url, { method: 'POST' });
  if (!res.ok) fail(`POST ${url} → ${res.status}`);
}
if (cleanOnly) {
  console.log('\n✓ clean. Open http://localhost:3050');
  process.exit(0);
}

// Sessions for the two demo users.
async function signIn(email: string) {
  const res = await fetch(`${AGENT}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email, password: 'demo-password' }),
  });
  if (!res.ok) fail(`sign-in as ${email} → ${res.status}`);
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}
const operator = await signIn('operator@demo.dev');
const approver = await signIn('approver@demo.dev');
const api = async (cookie: string, path: string, init: RequestInit = {}): Promise<Json> => {
  const res = await fetch(`${AGENT}${path}`, {
    ...init,
    headers: { cookie, origin: ORIGIN, 'content-type': 'application/json', ...init.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) fail(`${init.method ?? 'GET'} ${path} → ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body as Json;
};
async function waitFor<T>(what: string, check: () => Promise<T | undefined>, timeoutMs = 10 * 60_000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await check();
    if (value !== undefined) return value;
    await Bun.sleep(4000);
  }
  return fail(`timed out waiting for ${what}`);
}

const locations = (await api(operator, '/api/locations')).items as Array<{ id: string; name: string }>;
const locationId = (name: string) => locations.find((l) => l.name === name)?.id ?? fail(`no location named ${name}`);

async function startRun(location: string) {
  const { runId } = await api(operator, '/api/runs', { method: 'POST', body: JSON.stringify({ locationIds: [locationId(location)] }) });
  return waitFor(`the ${location} run to propose`, async () => {
    const run = await api(operator, `/api/runs/${runId}`);
    if (run.status === 'failed') fail(`the ${location} run failed (is ANTHROPIC_API_KEY set in .env?)`);
    return run.proposal?.status === 'pending_approval' ? (run.proposal as Json) : undefined;
  });
}
async function approve(proposalId: string) {
  const { version } = await api(approver, `/api/proposals/${proposalId}`);
  await api(approver, `/api/proposals/${proposalId}/decision`, { method: 'POST', body: JSON.stringify({ decision: 'approve', expectedVersion: version }) });
  return waitFor('the approved changes to be written', async () => {
    const p = await api(approver, `/api/proposals/${proposalId}`);
    if (p.status === 'failed') fail(`execution failed for proposal ${proposalId}`);
    return p.status === 'executed' ? p : undefined;
  });
}

// 3. An executed restock.
step(`restock run for ${FIRST} (agents working, about a minute)`);
const first = await startRun(FIRST);
console.log(`  proposed: ${first.title}`);
step('approving it as the approver and writing the changes');
const executed = await approve(first.id);
console.log(`  executed ${executed.ops.length} changes, each verified`);

// 4. A vendor replies to one of the new POs with a partial shipment.
const email = (executed.ops as Json[]).find((o) => o.action === 'email.send_vendor_po');
if (email) {
  const to = Array.isArray(email.input.to) ? email.input.to[0] : email.input.to;
  const line = /^- (\S+) .*?: (\d+) units/m.exec(email.input.body_markdown ?? '');
  const ordered = line ? Number(line[2]) : undefined;
  step(`${email.input.vendor_name} replies: partial shipment`);
  const before = Date.now();
  await fetch(`${EMU}/__emu/simulate/vendor-reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ vendor: to, kind: 'partial', sku: line?.[1], ordered, shipped: ordered ? Math.max(1, Math.round(ordered * 0.6)) : undefined }),
  });
  const reply = await waitFor('the vendor-reply proposal', async () => {
    const { items } = await api(approver, '/api/proposals?status=pending_approval');
    return (items as Json[]).find((p) => p.title?.startsWith('Vendor reply') && Date.parse(p.createdAt) >= before - 5000);
  });
  console.log(`  proposed: ${reply.title}`);
}

// 5. A restock left waiting, to walk through live.
step(`restock run for ${SECOND}, left waiting for approval`);
const second = await startRun(SECOND);
console.log(`  proposed: ${second.title}`);

console.log(`
✓ ready. Open http://localhost:3050
    executed   ${executed.title}   /approvals/${executed.id}
    waiting    ${second.title}   /approvals/${second.id}
`);
