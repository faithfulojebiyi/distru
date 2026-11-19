/**
 * Slack approval posts are idempotent per proposal: a retried workflow step (proposalCreated called
 * twice) updates the stored message instead of posting a second approval request or notice.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { slackWorkspace } from '@ops/emulators';
import { createWorld, type World } from '@ops/emulators-server';
import { agentPrincipal, type Proposal } from '@ops/harness';
import { InMemorySlackMessageStore, SlackApprovals } from '../src/slack/approvals';

let world: World;
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  world = createWorld({ pollMs: 0 });
  server = Bun.serve({ port: 0, fetch: (r) => world.fetch(r) });
});

afterAll(async () => {
  server.stop(true);
  await world.close();
});

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    version: 1,
    status: 'pending_approval',
    title: 'Restock: 1 PO ($1,200.00) for Humboldt Farms',
    rationale: null,
    meta: {},
    createdBy: agentPrincipal('procurement-planner', 'Procurement Planner'),
    createdAt: now,
    updatedAt: now,
    ops: [],
    policy: { outcome: 'needs_approval', reasons: [] },
    decision: null,
    execution: null,
    ...overrides,
  };
}

const slackFor = (messages: InMemorySlackMessageStore) =>
  new SlackApprovals(
    { token: world.config.slackBotToken, apiUrl: `http://127.0.0.1:${server.port}/slack/api/`, approvalsChannel: '#ops-approvals', notifyChannel: '#purchasing', webBaseUrl: 'http://web.test' },
    { registry: () => ({ connectorOf: () => undefined }), messages },
  );

const bot = (channel: string) => slackWorkspace(world.slack).messages(channel).filter((m) => m.botId !== null);

describe('SlackApprovals idempotency', () => {
  test('a retried proposalCreated updates the approval message and notice instead of posting again', async () => {
    const messages = new InMemorySlackMessageStore();
    const slack = slackFor(messages);
    const p = proposal();
    const approvalsBefore = bot('ops-approvals').length;
    const noticesBefore = bot('purchasing').length;

    await slack.proposalCreated(p);
    const first = await slack.approvalMessage(p.id);
    expect(first).not.toBeNull();
    expect(bot('ops-approvals').length).toBe(approvalsBefore + 1);
    expect(bot('purchasing').length).toBe(noticesBefore + 1);

    // Retry (same process or, with the Drizzle store, after a restart): no new messages.
    await slack.proposalCreated({ ...p, title: 'Restock: 1 PO ($1,250.00) for Humboldt Farms' });
    expect(await slack.approvalMessage(p.id)).toEqual(first);
    expect(bot('ops-approvals').length).toBe(approvalsBefore + 1);
    expect(bot('purchasing').length).toBe(noticesBefore + 1);
    expect(bot('ops-approvals').at(-1)?.text).toContain('$1,250.00');

    // A new store (another process with no record) would post again: the store is what makes it idempotent.
    expect(await slackFor(new InMemorySlackMessageStore()).approvalMessage(p.id)).toBeNull();
  });

  test('once decided, a late retry never re-adds the buttons', async () => {
    const messages = new InMemorySlackMessageStore();
    const slack = slackFor(messages);
    const p = proposal();
    const ref = await slack.postApprovalRequest(p);
    const count = bot('ops-approvals').length;
    expect(await slack.postApprovalRequest({ ...p, status: 'approved' })).toEqual(ref);
    expect(bot('ops-approvals').length).toBe(count);
  });

  test('finished notices are posted once per outcome', async () => {
    const slack = slackFor(new InMemorySlackMessageStore());
    const p = proposal({ status: 'executed' });
    const before = bot('purchasing').length;
    await slack.proposalFinished(p);
    await slack.proposalFinished(p);
    expect(bot('purchasing').length).toBe(before + 1);
  });
});
