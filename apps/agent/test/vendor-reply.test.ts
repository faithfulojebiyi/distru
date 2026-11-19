/**
 * The vendor-reply loop and Slack approvals end to end, in-process, no live servers:
 *
 *   in-process emulator world (Composio + Gmail + Slack, served on a loopback port for the official
 *   SDKs) ── vendor replies to a PO ──▶ signed Composio webhook ──▶ POST /api/webhooks/composio
 *   (loopback, our real route) ──▶ vendor-reply workflow (scripted Vendor Liaison, Distru mock,
 *   in-memory harness) ──▶ proposal ──▶ Slack approval message ──▶ member clicks ──▶ signed
 *   block_actions ──▶ POST /api/webhooks/slack ──▶ harness.decide ──▶ resume ──▶ execute.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { buildPurchaseOrder } from '@ops/distru-client';
import { createComposioClient, createComposioConnector } from '@ops/connector-composio';
import { gmailMailbox, slackWorkspace } from '@ops/emulators';
import { createWorld, type World } from '@ops/emulators-server';
import { DecisionConflictError, InMemoryAuditSink, userPrincipal, type Proposal, type TriggerEvent } from '@ops/harness';
import { Hono } from 'hono';
import { z } from 'zod';
import { createComposioWebhookRoutes } from '../src/api/webhooks-composio';
import { createSlackWebhookRoutes } from '../src/api/webhooks-slack';
import type { SessionUser } from '../src/auth/session';
import { VendorReplyResultSchema } from '../src/mastra/workflows/vendor-reply';
import { resumeRunOnDecision } from '../src/services/runs';
import { SlackApprovals } from '../src/slack/approvals';
import { slackSignature } from '../src/slack/trigger';
import { restockEnv, type RestockEnv } from './fixtures/restock-env';

const COMPOSIO_SECRET = 'whsec_vendor_reply_test';
const SLACK_SECRET = 'slack-signing-secret-test';
const VENDOR = 'orders@mojaveprerollco.com';
const USERS: Record<string, SessionUser> = {
  'approver@demo.dev': { id: 'u-adam', email: 'approver@demo.dev', name: 'Adam Approver', role: 'approver' },
  'operator@demo.dev': { id: 'u-olivia', email: 'operator@demo.dev', name: 'Olivia Operator', role: 'operator' },
};

const PoInput = z.object({ purchase_id: z.string(), lines: z.array(z.object({ product_id: z.string(), quantity: z.number(), unit_price: z.number() })) });
const ReplyInput = z.object({ thread_id: z.string(), recipient_email: z.string(), message_body: z.string() });
const CapCheck = z.object({ product_id: z.string(), runs_out_before_eta: z.boolean(), cap: z.number().nullable() });
const Meta = z.object({ workflowId: z.literal('vendor-reply'), workflowRunId: z.string(), capChecks: z.array(CapCheck), injectionDetected: z.boolean(), changes: z.array(z.object({ field: z.string(), from: z.number(), to: z.number() })) });

let world: World;
let worldServer: ReturnType<typeof Bun.serve>;
let agentServer: ReturnType<typeof Bun.serve>;
let baseURL: string;
let env: RestockEnv;
let slack: SlackApprovals;
const audit = new InMemoryAuditSink();
const queued: TriggerEvent[] = [];
const runIds: string[] = [];
const decisions: Array<{ proposalId: string; by: string }> = [];

async function until<T>(what: string, fn: () => Promise<T | null | undefined> | T | null | undefined, timeoutMs = 15_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await Bun.sleep(20);
  }
}

beforeAll(async () => {
  // The agent's webhook routes on a loopback port (handler bound below, once env exists).
  let handler: (r: Request) => Response | Promise<Response> = () => new Response('booting', { status: 503 });
  agentServer = Bun.serve({ port: 0, fetch: (r) => handler(r) });
  const agentUrl = `http://127.0.0.1:${agentServer.port}`;

  world = createWorld({ composioWebhookUrl: `${agentUrl}/api/webhooks/composio`, composioWebhookSecret: COMPOSIO_SECRET, slackEventsUrl: `${agentUrl}/api/webhooks/slack`, slackSigningSecret: SLACK_SECRET, pollMs: 0 });
  worldServer = Bun.serve({ port: 0, fetch: (r) => world.fetch(r) });
  baseURL = `http://127.0.0.1:${worldServer.port}`;

  let registryOf: () => RestockEnv['connectors']['registry'] = () => {
    throw new Error('not ready');
  };
  slack = new SlackApprovals(
    { token: world.config.slackBotToken, apiUrl: `${baseURL}/slack/api/`, approvalsChannel: '#ops-approvals', notifyChannel: '#purchasing', webBaseUrl: 'http://web.test' },
    { registry: () => registryOf() },
  );
  env = await restockEnv({
    composio: () => createComposioConnector({ client: createComposioClient({ apiKey: world.config.composioApiKey, baseURL, userId: 'golden-coast' }), toolkits: ['gmail', 'googlecalendar'], id: 'composio' }),
    notifier: slack,
  });
  registryOf = () => env.connectors.registry;
  const resume = resumeRunOnDecision(env.launcher);

  const app = new Hono();
  app.route(
    '/',
    createComposioWebhookRoutes({
      triggers: () => env.connectors.registry,
      audit,
      secret: COMPOSIO_SECRET,
      send: async (event) => {
        if (queued.some((q) => q.id === event.id)) return; // Inngest dedupes by event id
        queued.push(event);
        runIds.push((await env.launcher.startVendorReply(event.data)).runId);
      },
    }),
  );
  app.route(
    '/',
    createSlackWebhookRoutes({
      triggers: () => env.connectors.registry,
      audit,
      signingSecret: SLACK_SECRET,
      slack,
      findUserByEmail: async (email) => USERS[email] ?? null,
      decide: async (proposalId, user, decision) => {
        try {
          const p = await env.harness.decide({ ctx: env.contexts.read, principal: userPrincipal(user.id, user.role, user.name), proposalId, decision });
          decisions.push({ proposalId, by: user.email });
          await resume(p);
          return p;
        } catch (err) {
          if (err instanceof DecisionConflictError) await resume(await env.harness.get(proposalId));
          throw err;
        }
      },
      getProposal: (id) => env.harness.get(id),
    }),
  );
  handler = (r) => app.fetch(r);
});

afterAll(async () => {
  await world.close();
  worldServer.stop(true);
  agentServer.stop(true);
});

/** A PENDING PO for Mojave Pre-Roll Co.: 312 × PRE-BD-1G at Oakland (what a restock run would have created). */
async function createPo(quantity = 312) {
  const client = env.contexts.read.connectors.distru;
  const product = z.object({ id: z.string(), vendor: z.object({ id: z.string() }), unit_cost: z.number() }).parse(await env.connectors.registry.runReadTool(env.contexts.read, env.approver, 'distru.products_get', { sku: 'PRE-BD-1G' }));
  const oakland = (await env.locations()).find((l) => l.name.startsWith('Oakland'))!;
  const po = (await client.upsertPurchase(buildPurchaseOrder({ vendorId: product.vendor.id, locationId: oakland.id, lines: [{ productId: product.id, quantity, unitPrice: product.unit_cost }], description: 'Restock' }))).data!;
  return { id: po.id, number: po.purchase_number, productId: product.id, unitPrice: product.unit_cost };
}

async function reply(body: Record<string, unknown>) {
  const before = runIds.length;
  const res = await world.fetch(new Request('http://emu/__emu/simulate/vendor-reply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  expect(res.ok).toBe(true);
  await until('vendor-reply run started', () => runIds.length > before);
  return runIds.at(-1)!;
}

const approvalMessages = () => slackWorkspace(world.slack).messages('ops-approvals').filter((m) => m.botId !== null);
const purchasingMessages = () => slackWorkspace(world.slack).messages('purchasing').map((m) => m.text);
const ephemeralFor = (user: string) => slackWorkspace(world.slack).ephemeral('ops-approvals', user).map((m) => m.text);
const click = (user: string, ts: string, actionId: string, value: string) => slackWorkspace(world.slack).click(user, 'ops-approvals', ts, { actionId, value });

describe('vendor-reply loop + Slack approvals (in-process emulators, scripted models)', () => {
  let po: Awaited<ReturnType<typeof createPo>>;
  let proposal: Proposal;
  let runId: string;
  let ts: string;

  test('partial shipment: Composio webhook → Liaison → PO 312→200, cap check, reply email op, buyer task; Slack approval posted', async () => {
    po = await createPo();
    runId = await reply({ vendor: 'MPR', kind: 'partial', poNumber: po.number, ordered: 312, shipped: 200, eta: 'Dec 2' });

    // Trigger audited and queued with a dedupe id.
    expect(queued.at(-1)).toMatchObject({ name: 'composio/gmail.new_message', id: expect.stringMatching(/^composio\.gmail\.new_message:/) });
    expect(audit.events.some((e) => e.type === 'trigger.received' && e.data.triggerId === 'composio.gmail.new_message')).toBe(true);

    await env.waitForVendorReply(runId, ['suspended']);
    proposal = (await env.findProposalByRunId(runId))!;
    expect(proposal.status).toBe('pending_approval');
    expect(proposal.createdBy).toMatchObject({ kind: 'agent', id: 'vendor-liaison' });
    const meta = Meta.parse(proposal.meta);
    expect(meta.injectionDetected).toBe(false);
    expect(meta.changes).toEqual([expect.objectContaining({ field: 'quantity', from: 312, to: 200 })]);

    const actions = proposal.ops.map((o) => o.action);
    expect(actions[0]).toBe('distru.purchases.upsert');
    const poInput = PoInput.parse(proposal.ops[0]!.input);
    expect(poInput.purchase_id).toBe(po.id);
    expect(poInput.lines).toEqual([{ product_id: po.productId, quantity: 200, unit_price: po.unitPrice }]);
    expect(proposal.ops[0]!.diff.some((d) => d.after === 200 && d.before === 312)).toBe(true);

    // Cap: present exactly when the code found stock runs out before the ETA, with the computed value.
    const check = meta.capChecks.find((c) => c.product_id === po.productId)!;
    expect(check).toBeDefined();
    const capOps = proposal.ops.filter((o) => o.action === 'distru_mcp.mutate_product');
    if (check.runs_out_before_eta && check.cap !== null) expect(capOps.map((o) => o.input)).toEqual([{ action: 'UPDATE', id: po.productId, maxMenuBuyerOrderQuantity: check.cap }]);
    else expect(capOps).toHaveLength(0);

    const replyOp = proposal.ops.find((o) => o.action === 'composio.gmail_reply_to_thread')!;
    expect(replyOp.risk).toBe('high');
    const r = ReplyInput.parse(replyOp.input);
    expect(r.recipient_email).toBe(VENDOR);
    expect(r.message_body).toContain(`updated ${po.number} to the 200 units`);
    expect(r.message_body).toContain('2026-12-02');
    const task = proposal.ops.find((o) => o.action === 'distru.tasks.create')!;
    expect(z.object({ name: z.string(), purchase_id: z.string(), due: z.string() }).parse(task.input)).toMatchObject({ purchase_id: po.id, due: '2026-12-02', name: expect.stringContaining('200 of 312') });
    expect(env.net.purchaseWrites).toBe(1); // only createPo; nothing written by the workflow yet

    // Slack: Block Kit approval request with buttons + a #purchasing notification.
    const msg = await until('approval message', () => approvalMessages().find((m) => JSON.stringify(m.blocks).includes(proposal.id)));
    ts = msg.ts;
    const blocks = JSON.stringify(msg.blocks);
    expect(blocks).toContain('Approval needed');
    expect(blocks).toContain('proposal_approve');
    expect(blocks).toContain('proposal_reject');
    expect(blocks).toContain(`http://web.test/approvals/${proposal.id}`);
    expect(blocks).toContain('ERP · distru');
    expect(blocks).toContain('high_risk_requires_approval');
    expect(purchasingMessages().some((t) => t.includes('Proposal created') && t.includes(proposal.id))).toBe(true);
  });

  test('an operator clicking Approve is refused by the harness (ephemeral), nothing changes', async () => {
    const before = ephemeralFor('olivia').length;
    click('olivia', ts, 'proposal_approve', proposal.id);
    const msgs = await until('ephemeral to olivia', () => (ephemeralFor('olivia').length > before ? ephemeralFor('olivia') : null));
    expect(msgs.at(-1)).toContain('Only approvers can decide');
    expect((await env.harness.get(proposal.id)).status).toBe('pending_approval');
    expect(decisions).toHaveLength(0);
  });

  test('a tampered or unsigned Slack payload is rejected with 401 and audited', async () => {
    const body = new URLSearchParams({ payload: JSON.stringify({ type: 'block_actions', user: { id: 'U1' }, actions: [{ action_id: 'proposal_approve', value: proposal.id }] }) }).toString();
    const now = Math.floor(Date.now() / 1000);
    const url = `http://127.0.0.1:${agentServer.port}/api/webhooks/slack`;
    const post = (headers: Record<string, string>, b = body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: b });
    const good = await slackSignature(SLACK_SECRET, now, body);
    expect((await post({ 'x-slack-request-timestamp': String(now), 'x-slack-signature': await slackSignature('attacker', now, body) })).status).toBe(401);
    expect((await post({ 'x-slack-request-timestamp': String(now), 'x-slack-signature': good }, body.replace('U1', 'U2'))).status).toBe(401);
    expect((await post({ 'x-slack-request-timestamp': String(now - 3600), 'x-slack-signature': await slackSignature(SLACK_SECRET, now - 3600, body) })).status).toBe(401);
    expect((await post({})).status).toBe(401);
    expect(audit.events.filter((e) => e.type === 'trigger.rejected' && e.data.triggerId === 'slack.interaction')).toHaveLength(4);
    // A forged Composio delivery too.
    const forged = await fetch(`http://127.0.0.1:${agentServer.port}/api/webhooks/composio`, { method: 'POST', headers: { 'webhook-id': 'x', 'webhook-timestamp': String(now), 'webhook-signature': 'v1,AAAA' }, body: '{}' });
    expect(forged.status).toBe(401);
    expect((await env.harness.get(proposal.id)).status).toBe('pending_approval');
  });

  test('the approver approves from Slack → decided with his principal, message updated, run resumes and executes', async () => {
    click('adam', ts, 'proposal_approve', proposal.id);
    const state = await env.waitForVendorReply(runId, ['success', 'failed']);
    expect(state.status).toBe('success');
    const result = VendorReplyResultSchema.parse(state.result);
    expect(result).toMatchObject({ status: 'executed', kind: 'partial', purchaseNumber: po.number, suspicious: false });

    const p = await env.harness.get(proposal.id);
    expect(p.status).toBe('executed');
    expect(p.decision).toMatchObject({ decision: 'approve', by: { kind: 'user', id: 'u-adam', scopes: expect.arrayContaining(['approve']) } });
    expect(p.ops.every((o) => o.status === 'executed' && (o.result?.mismatches.length ?? 0) === 0)).toBe(true);

    // Distru: the PO now has 200 units; the vendor got the acknowledgement in its thread.
    const stored = (await env.contexts.read.connectors.distru.getPurchase(po.id)).data!;
    expect(stored.items.map((i) => Number(i.quantity))).toEqual([200]);
    const inbox = gmailMailbox(world.google, VENDOR).inbox();
    expect(inbox.some((m) => (m.text ?? '').includes(`updated ${po.number} to the 200 units`))).toBe(true);
    expect(env.net.taskWrites).toBe(1);

    // Slack: buttons replaced by the outcome; #purchasing told it executed.
    const updated = await until('updated message', () => {
      const m = approvalMessages().find((x) => x.ts === ts);
      return m && JSON.stringify(m.blocks).includes('Approved') ? m : null;
    });
    expect(JSON.stringify(updated.blocks)).not.toContain('proposal_approve');
    expect(JSON.stringify(updated.blocks)).toContain('Adam Approver');
    await until('executed notification', () => purchasingMessages().some((t) => t.startsWith('Executed') && t.includes(proposal.id)));
  });

  test('a second click gets a conflict message; nothing runs twice', async () => {
    const before = ephemeralFor('adam').length;
    // The approval message no longer has buttons; a stale client can still post the old action.
    click('adam', ts, 'proposal_approve', proposal.id);
    const msgs = await until('conflict ephemeral', () => (ephemeralFor('adam').length > before ? ephemeralFor('adam') : null));
    expect(msgs.at(-1)).toContain('Already decided: approved by Adam Approver');
    expect(env.net.taskWrites).toBe(1);
    expect(decisions).toHaveLength(1);
  });

  test('injection reply: flagged, no proposal, no writes, no reply; #purchasing is told', async () => {
    const purchases = env.net.purchaseWrites;
    const tasks = env.net.taskWrites;
    const sentBefore = gmailMailbox(world.google, 'purchasing@goldencoastdistro.com').sent().length;
    const id = await reply({ vendor: 'MPR', kind: 'injection', poNumber: po.number });
    const state = await env.waitForVendorReply(id, ['success', 'failed']);
    const result = VendorReplyResultSchema.parse(state.result);
    expect(result).toMatchObject({ status: 'flagged', proposalId: null, suspicious: true, kind: 'confirm' });
    expect(result.findings.join(' ')).toContain('prompt injection');
    expect(await env.findProposalByRunId(id)).toBeNull();
    expect(env.net.purchaseWrites).toBe(purchases);
    expect(env.net.taskWrites).toBe(tasks);
    expect(gmailMailbox(world.google, 'purchasing@goldencoastdistro.com').sent().length).toBe(sentBefore);
    await until('flag notification', () => purchasingMessages().some((t) => t.startsWith('Flagged vendor email')));
  });

  test('a reply naming a PO that is not the vendor’s never touches another vendor’s PO', async () => {
    const id = await reply({ vendor: 'MPR', kind: 'confirm', poNumber: 'PO-99999' });
    const state = await env.waitForVendorReply(id, ['success', 'failed']);
    // PO-99999 is not a PO of the vendor; the vendor has exactly one open PO (ours) → falls back to it only when no number is given.
    expect(VendorReplyResultSchema.parse(state.result).status).toMatch(/ignored|no_action/);
  });
});
