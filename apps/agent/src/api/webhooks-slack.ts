/**
 * POST /api/webhooks/slack: Slack interactivity (Approve / Reject on an approval request).
 *
 *   raw body → ingestWebhook(`slack.interaction`): x-slack-signature v0 + timestamp tolerance (401 on failure)
 *   → block_actions → map the Slack member to an Ops Agent user by email
 *   → decide(proposal, that user, approve|reject)   (harness.decide with the user's own principal;
 *     an operator is refused by the harness's scope check, a second click gets a conflict)
 *   → chat.update the message with the outcome (or an ephemeral message to the clicker)
 *   → the decision hook resumes the suspended workflow (restock or vendor-reply).
 *
 * Slack expects a 200 within 3 s; the body is ignored.
 */
import { DecisionConflictError, ForbiddenError, ingestWebhook, PolicyDeniedError, type AuditSink, type Clock, type Proposal, type TriggerSource } from '@ops/harness';
import { Hono } from 'hono';
import { z } from 'zod';
import type { SessionUser } from '../auth/session';
import { APPROVE_ACTION_ID, REJECT_ACTION_ID, type SlackApprovals } from '../slack/approvals';
import { SLACK_INTERACTION_TRIGGER_ID, SlackBlockActionsEventSchema } from '../slack/trigger';
import { rawBodyOf } from './webhook-support';

export const SLACK_WEBHOOK_PATH = '/api/webhooks/slack';

const UrlVerification = z.object({ type: z.literal('url_verification'), challenge: z.string() });
const safeJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export interface SlackWebhookDeps {
  triggers: () => TriggerSource;
  audit: AuditSink;
  clock?: Clock;
  signingSecret: string;
  slack: SlackApprovals;
  /** Ops Agent user by email (Better Auth `user` table), or null. */
  findUserByEmail: (email: string) => Promise<SessionUser | null>;
  /** Records the decision (harness.decide with the user's principal) and resumes the workflow. */
  decide: (proposalId: string, user: SessionUser, decision: 'approve' | 'reject') => Promise<Proposal>;
  /** Current proposal (for the conflict message). */
  getProposal: (proposalId: string) => Promise<Proposal | null>;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export type SlackClickOutcome =
  | { kind: 'decided'; proposalId: string; decision: 'approve' | 'reject'; by: string }
  | { kind: 'refused'; proposalId: string; reason: 'not_linked' | 'forbidden' | 'conflict' | 'policy_denied' | 'error'; message: string };

const nameOf = (p: Proposal) => p.decision?.by.label ?? p.decision?.by.id ?? 'someone';

export function createSlackWebhookRoutes(deps: SlackWebhookDeps) {
  const app = new Hono();

  async function handleClick(event: ReturnType<typeof SlackBlockActionsEventSchema.parse>, action: { actionId: string; value: string | null }): Promise<SlackClickOutcome | null> {
    if (action.actionId !== APPROVE_ACTION_ID && action.actionId !== REJECT_ACTION_ID) return null;
    const proposalId = action.value ?? '';
    const decision = action.actionId === APPROVE_ACTION_ID ? 'approve' : 'reject';
    const channel = event.channelId;
    const tell = async (text: string) => {
      if (channel) await deps.slack.ephemeral(channel, event.user.id, text);
    };

    const email = await deps.slack.userEmail(event.user.id);
    const user = email ? await deps.findUserByEmail(email) : null;
    if (!user) {
      const message = `Your Slack account${email ? ` (${email})` : ''} is not linked to an Ops Agent user, so you cannot decide proposals.`;
      await tell(message);
      return { kind: 'refused', proposalId, reason: 'not_linked', message };
    }

    try {
      const decided = await deps.decide(proposalId, user, decision);
      const verb = decision === 'approve' ? 'Approved' : 'Rejected';
      const outcome = `*${verb}* by ${user.name} (${user.email}) via Slack at ${(deps.clock?.now() ?? new Date()).toISOString()}${decision === 'approve' ? '. Executing now.' : '. Nothing will be written.'}`;
      if (channel && event.messageTs) await deps.slack.updateApprovalMessage(channel, event.messageTs, decided, outcome);
      return { kind: 'decided', proposalId, decision, by: user.email };
    } catch (err) {
      if (err instanceof ForbiddenError) {
        const message = `Only approvers can decide proposals. ${user.name} is ${user.role === 'operator' ? 'an operator' : `a ${user.role}`}; ask an approver to review it.`;
        await tell(message);
        return { kind: 'refused', proposalId, reason: 'forbidden', message };
      }
      if (err instanceof DecisionConflictError) {
        const current = await deps.getProposal(proposalId);
        const message = current?.decision ? `Already decided: ${current.decision.decision === 'approve' ? 'approved' : 'rejected'} by ${nameOf(current)} at ${current.decision.at}.` : `This proposal can no longer be decided (status ${current?.status ?? 'unknown'}).`;
        await tell(message);
        return { kind: 'refused', proposalId, reason: 'conflict', message };
      }
      if (err instanceof PolicyDeniedError) {
        const message = `Policy denies this proposal now: ${err.message}`;
        await tell(message);
        return { kind: 'refused', proposalId, reason: 'policy_denied', message };
      }
      const message = `Could not record your decision: ${err instanceof Error ? err.message : String(err)}`;
      deps.log?.('slack decision failed', { proposalId, error: message });
      await tell(message);
      return { kind: 'refused', proposalId, reason: 'error', message };
    }
  }

  app.post(SLACK_WEBHOOK_PATH, async (c) => {
    const raw = await rawBodyOf(c.req.raw);
    const result = await ingestWebhook(deps.triggers(), SLACK_INTERACTION_TRIGGER_ID, raw, c.req.raw.headers, { SLACK_SIGNING_SECRET: deps.signingSecret }, { audit: deps.audit, ...(deps.clock ? { clock: deps.clock } : {}) });
    if (result.status === 'rejected') return c.json({ error: result.reason, message: result.message }, result.httpStatus);
    if (result.status === 'ignored') {
      // Signature verified above: answer the Events API URL-verification handshake.
      const challenge = UrlVerification.safeParse(safeJson(raw));
      if (challenge.success) return c.json({ challenge: challenge.data.challenge });
      return c.json({ ok: true, outcomes: [] });
    }
    const event = SlackBlockActionsEventSchema.parse(result.event.data);
    const outcomes: SlackClickOutcome[] = [];
    for (const action of event.actions) {
      const outcome = await handleClick(event, action);
      if (outcome) outcomes.push(outcome);
    }
    return c.json({ ok: true, outcomes });
  });

  return app;
}
