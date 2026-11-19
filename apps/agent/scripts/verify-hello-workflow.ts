/**
 * End-to-end check that the Inngest-backed `hello` workflow suspends and resumes.
 * Prereqs: server on :4111, Inngest dev server (`bun run inngest:dev` from the repo root), seeded users.
 *
 *   bun scripts/verify-hello-workflow.ts
 */
export {};

const BASE = process.env.AGENT_URL ?? 'http://localhost:4111';
const WORKFLOW = 'helloWorkflow';

async function call<T>(path: string, init: RequestInit & { cookie?: string } = {}): Promise<{ status: number; body: T; headers: Headers }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://localhost:3050',
      ...(init.cookie ? { Cookie: init.cookie } : {}),
      ...init.headers,
    },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body: body as T, headers: res.headers };
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok   ${msg}`);
}

const signIn = await call<{ user: { email: string } }>('/api/auth/sign-in/email', {
  method: 'POST',
  body: JSON.stringify({ email: 'approver@demo.dev', password: 'demo-password' }),
});
assert(signIn.status === 200, `sign in as approver (${signIn.status})`);
const cookie = signIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

const unauth = await call(`/api/workflows/${WORKFLOW}`);
assert(unauth.status === 401, `Mastra workflow route rejects anonymous calls (${unauth.status})`);

const created = await call<{ runId: string }>(`/api/workflows/${WORKFLOW}/create-run`, { method: 'POST', cookie, body: '{}' });
assert(created.status === 200 && created.body.runId, `create run (${created.status})`);
const { runId } = created.body;
console.log(`     runId=${runId}`);

type RunResult = { status: string; steps?: Record<string, { status: string; suspendPayload?: unknown; output?: unknown }>; result?: unknown };

const started = await call<RunResult>(`/api/workflows/${WORKFLOW}/start-async?runId=${runId}`, {
  method: 'POST',
  cookie,
  body: JSON.stringify({ inputData: { name: 'Distru' } }),
});
console.log(`     start → ${JSON.stringify(started.body).slice(0, 300)}`);
assert(started.status === 200 && started.body.status === 'suspended', `run suspends at await-approval (status=${started.body.status})`);

const snapshot = await call<{ status?: string }>(`/api/workflows/${WORKFLOW}/runs/${runId}`, { cookie });
console.log(`     stored run → status=${snapshot.body.status}`);

const resumed = await call<RunResult>(`/api/workflows/${WORKFLOW}/resume-async?runId=${runId}`, {
  method: 'POST',
  cookie,
  body: JSON.stringify({ step: 'await-approval', resumeData: { approved: true, approvedBy: 'approver@demo.dev' } }),
});
console.log(`     resume → ${JSON.stringify(resumed.body).slice(0, 300)}`);
assert(resumed.status === 200 && resumed.body.status === 'success', `run resumes and completes (status=${resumed.body.status})`);

console.log('hello workflow suspend → resume through Inngest: PASS');
