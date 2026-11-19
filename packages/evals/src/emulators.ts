/**
 * apps/emulators booted in-process for scenarios that need Gmail / Composio / Slack: the emulator world
 * and the agent's real webhook routes (`/api/webhooks/composio`, `/api/webhooks/slack`) each on a
 * loopback port (the official Composio and Slack SDKs make real HTTP calls), wired like
 * apps/agent/test/vendor-reply.test.ts. Imports apps/* sources read-only.
 *
 * Gmail ids are random (thread / message ids, Message-ID headers), dates are real time (the webhook
 * signatures must be fresh, so the emulators can't run on the mock's fixed clock), and the vendor-reply workflow shows
 * the thread to the Vendor Liaison, so `volatile()` lists them: the LLM gateway replaces each with a
 * stable alias before the request is fingerprinted, which keeps recordings replayable.
 */
import { gmailMailbox, slackWorkspace } from '@ops/emulators';
import { DecisionConflictError, InMemoryAuditSink, userPrincipal, type Harness, type Proposal, type TriggerEvent } from '@ops/harness';
import { createComposioClient, createComposioConnector } from '../../connector-composio/src';
import { createComposioWebhookRoutes } from '../../../apps/agent/src/api/webhooks-composio';
import { createSlackWebhookRoutes } from '../../../apps/agent/src/api/webhooks-slack';
import type { SessionUser } from '../../../apps/agent/src/auth/session';
import type { AppConnectors, AppCtx } from '../../../apps/agent/src/harness/registry';
import type { RestockLauncher } from '../../../apps/agent/src/mastra/restock-launcher';
import { resumeRunOnDecision } from '../../../apps/agent/src/services/runs';
import { SlackApprovals } from '../../../apps/agent/src/slack/approvals';
import { createWorld as createEmulatorWorld, type World as EmulatorWorld } from '../../../apps/emulators/src/world';
import { PURCHASING, VENDORS } from '../../../apps/emulators/src/domain';
import type { VendorReplyRequest } from '../../../apps/emulators/src/replies';

const COMPOSIO_SECRET = 'whsec_evals_vendor_reply';
const SLACK_SECRET = 'evals-slack-signing-secret';

/** The demo users behind the Slack members (apps/emulators SLACK_USERS → session users). */
export const SLACK_USERS: Record<string, SessionUser> = {
  'approver@demo.dev': { id: 'u-adam', email: 'approver@demo.dev', name: 'Adam Approver', role: 'approver' },
  'operator@demo.dev': { id: 'u-olivia', email: 'operator@demo.dev', name: 'Olivia Operator', role: 'operator' },
};
/** Slack handle → member (olivia is an operator, adam an approver). */
export const SLACK_MEMBERS = { operator: 'olivia', approver: 'adam' } as const;

export interface EmulatorsOptions {
  /** Connect the Composio connector (Gmail read tools, `composio.gmail_reply_to_thread`, the Gmail trigger). */
  composio?: boolean;
  /** Post approval requests to Slack and accept button clicks. */
  slack?: boolean;
}

/** What `attach` needs from the eval world (structural, so world.ts and this file don't import each other). */
export interface AttachableWorld {
  harness: Harness<AppCtx>;
  launcher: RestockLauncher;
  connectors: AppConnectors;
  contexts: { read: AppCtx };
}

export interface SlackClick {
  outcome: 'decided' | 'refused';
  /** Ephemeral text Slack showed the clicking member (refusals), else null. */
  message: string | null;
}

async function until<T>(what: string, fn: () => Promise<T | null | undefined> | T | null | undefined, timeoutMs = 30_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await Bun.sleep(20);
  }
}

export async function bootEmulators(options: EmulatorsOptions) {
  let handler: (r: Request) => Response | Promise<Response> = () => new Response('booting', { status: 503 });
  const agentServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (r) => handler(r) });
  const agentUrl = `http://127.0.0.1:${agentServer.port}`;
  const world: EmulatorWorld = createEmulatorWorld({
    composioWebhookUrl: `${agentUrl}/api/webhooks/composio`,
    composioWebhookSecret: COMPOSIO_SECRET,
    slackEventsUrl: `${agentUrl}/api/webhooks/slack`,
    slackSigningSecret: SLACK_SECRET,
    pollMs: 0,
  });
  const worldServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (r) => world.fetch(r) });
  const baseURL = `http://127.0.0.1:${worldServer.port}`;

  const audit = new InMemoryAuditSink();
  const queued: TriggerEvent[] = [];
  const runIds: string[] = [];
  let registryOf: () => AppConnectors['registry'] = () => {
    throw new Error('emulators: world not attached');
  };
  const slack = options.slack
    ? new SlackApprovals(
        { token: world.config.slackBotToken, apiUrl: `${baseURL}/slack/api/`, approvalsChannel: '#ops-approvals', notifyChannel: '#purchasing', webBaseUrl: 'http://web.test' },
        { registry: () => registryOf() },
      )
    : null;
  const connectComposio = options.composio
    ? async () => createComposioConnector({ client: createComposioClient({ apiKey: world.config.composioApiKey, baseURL, userId: 'golden-coast' }), toolkits: ['gmail', 'googlecalendar'], id: 'composio' })
    : null;

  const attach = async (w: AttachableWorld) => {
    registryOf = () => w.connectors.registry;
    const resume = resumeRunOnDecision(w.launcher);
    const composioRoutes = createComposioWebhookRoutes({
        triggers: () => w.connectors.registry,
        audit,
        secret: COMPOSIO_SECRET,
        send: async (event) => {
          if (queued.some((q) => q.id === event.id)) return; // Inngest dedupes by event id
          queued.push(event);
          runIds.push((await w.launcher.startVendorReply(event.data)).runId);
        },
      });
    const slackRoutes = slack
      ? createSlackWebhookRoutes({
          triggers: () => w.connectors.registry,
          audit,
          signingSecret: SLACK_SECRET,
          slack,
          findUserByEmail: async (email) => SLACK_USERS[email] ?? null,
          decide: async (proposalId, user, decision) => {
            try {
              const p = await w.harness.decide({ ctx: w.contexts.read, principal: userPrincipal(user.id, user.role, user.name), proposalId, decision });
              await resume(p);
              return p;
            } catch (err) {
              if (err instanceof DecisionConflictError) await resume(await w.harness.get(proposalId));
              throw err;
            }
          },
          getProposal: (id) => w.harness.get(id),
        })
      : null;
    handler = (r) => (slackRoutes && new URL(r.url).pathname.startsWith('/api/webhooks/slack') ? slackRoutes.fetch(r) : composioRoutes.fetch(r));
  };

  /** apps/emulators' simulate vendor-reply; resolves with the vendor-reply run it started. */
  const simulateVendorReply = async (req: VendorReplyRequest): Promise<string> => {
    const before = runIds.length;
    await world.simulateVendorReply(req);
    return until('vendor-reply run started', () => (runIds.length > before ? runIds.at(-1) : null));
  };

  /** Random Gmail ids anywhere in the purchasing / vendor mailboxes (see the file comment). */
  const volatile = (): string[] => {
    const out = new Set<string>();
    for (const email of [PURCHASING.email, ...VENDORS.map((v) => v.email)]) {
      for (const m of gmailMailbox(world.google, email).messages()) {
        out.add(m.id);
        out.add(m.threadId);
        const header = m.header('message-id');
        if (header) out.add(header.replace(/^<|>$/g, ''));
        // the emulators run on the real clock (their webhook signatures must be fresh), so dates vary too
        out.add(m.date.toISOString());
        out.add(String(m.date.getTime()));
        const date = m.header('date');
        if (date) out.add(date);
      }
    }
    return [...out].filter((v) => v.length >= 8);
  };

  /** A Slack member clicks Approve / Reject on the approval message of `proposal`. */
  const clickSlack = async (member: string, proposal: Proposal, action: 'proposal_approve' | 'proposal_reject'): Promise<SlackClick> => {
    const ws = slackWorkspace(world.slack);
    const msg = await until('Slack approval message', () => ws.messages('ops-approvals').find((m) => m.botId !== null && JSON.stringify(m.blocks).includes(proposal.id)));
    const ephemeralBefore = ws.ephemeral('ops-approvals', member).length;
    const statusBefore = (await registryHarness()).status;
    ws.click(member, 'ops-approvals', msg.ts, { actionId: action, value: proposal.id });
    // Either Slack shows the member an ephemeral refusal, or the proposal gets decided.
    return until('Slack click handled', async () => {
      const eph = ws.ephemeral('ops-approvals', member);
      if (eph.length > ephemeralBefore) return { outcome: 'refused' as const, message: eph.at(-1)?.text ?? null };
      const now = await registryHarness();
      return now.status !== statusBefore ? { outcome: 'decided' as const, message: null } : null;
    });

    async function registryHarness() {
      if (!attached) throw new Error('emulators: world not attached');
      return attached.harness.get(proposal.id);
    }
  };
  let attached: AttachableWorld | null = null;

  const close = async () => {
    await world.close();
    worldServer.stop(true);
    agentServer.stop(true);
  };

  return {
    world,
    audit,
    queued,
    runIds,
    slack,
    connectComposio,
    attach: async (w: AttachableWorld) => {
      attached = w;
      await attach(w);
    },
    simulateVendorReply,
    volatile,
    clickSlack,
    close,
  };
}

export type EmulatorsHandle = Awaited<ReturnType<typeof bootEmulators>>;
