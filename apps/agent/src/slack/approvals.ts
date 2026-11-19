/**
 * Slack approvals and run notifications (Slack Web API via `@slack/web-api`; the emulator locally).
 *
 * - A proposal that enters `pending_approval` is posted to the approvals channel as a Block Kit message:
 *   title, total, ops grouped by system, the policy reasons, a link to the proposal page and
 *   Approve / Reject buttons (`action_id` `proposal_approve` / `proposal_reject`, `value` = proposal id).
 * - Clicks come back through POST /api/webhooks/slack (`src/api/webhooks-slack.ts`), which decides
 *   through `harness.decide` with the clicking member's own principal and then updates the message.
 * - Run notifications (proposal created / executed / failed, flagged vendor email) go to the notify channel.
 *
 * Slack is a notification surface, never the source of truth: every failure here is logged and
 * swallowed (`safe`), so an outage cannot block a workflow step.
 */
import { WebClient, type KnownBlock } from '@slack/web-api';
import { totalValue, type Proposal, type Registry } from '@ops/harness';
import { z } from 'zod';

export const APPROVE_ACTION_ID = 'proposal_approve';
export const REJECT_ACTION_ID = 'proposal_reject';

export interface SlackConfig {
  token: string;
  /** Web API base (`http://localhost:4700/slack/api/` for the emulator); omit for real Slack. */
  apiUrl?: string;
  approvalsChannel: string;
  notifyChannel: string;
  /** Dashboard origin for links (`/approvals/<id>`). */
  webBaseUrl: string;
}

/** What the rest of the app calls (workflows + the Slack webhook route). Implemented by `SlackApprovals`. */
export interface ProposalNotifier {
  /** After `harness.propose`: approval request (pending) + a notification. */
  proposalCreated(p: Proposal): Promise<void>;
  /** After execution (executed / failed) or a terminal decision (rejected / denied). */
  proposalFinished(p: Proposal): Promise<void>;
  /** A free-form run notification (e.g. a flagged vendor email). */
  notice(text: string): Promise<void>;
}

/** No Slack configured. */
export const noopNotifier: ProposalNotifier = { proposalCreated: async () => {}, proposalFinished: async () => {}, notice: async () => {} };

type Block = KnownBlock;

const money = (n: number | null) => (n === null ? 'unknown' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const mrkdwnEscape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const SYSTEM_LABEL: Record<string, string> = { erp: 'ERP', email: 'Email', analytics: 'Analytics', other: 'Other', calendar: 'Calendar', crm: 'CRM', spreadsheet: 'Spreadsheet', compliance: 'Compliance' };

const SuspiciousList = z.array(z.object({ source: z.string().optional(), excerpt: z.string().optional() })).catch([]);

export class SlackApprovals implements ProposalNotifier {
  readonly client: WebClient;
  readonly #config: SlackConfig;
  readonly #registry: () => Pick<Registry<unknown>, 'connectorOf'>;
  readonly #log: (message: string, err?: unknown) => void;

  constructor(config: SlackConfig, options: { registry: () => Pick<Registry<unknown>, 'connectorOf'>; client?: WebClient; log?: (message: string, err?: unknown) => void }) {
    this.#config = config;
    this.#registry = options.registry;
    this.#log = options.log ?? ((m, e) => console.warn(`[slack] ${m}${e ? `: ${e instanceof Error ? e.message : String(e)}` : ''}`));
    this.client = options.client ?? new WebClient(config.token, { ...(config.apiUrl ? { slackApiUrl: config.apiUrl } : {}), retryConfig: { retries: 1 } });
  }

  get config(): SlackConfig {
    return this.#config;
  }

  proposalUrl(id: string): string {
    return `${this.#config.webBaseUrl.replace(/\/$/, '')}/approvals/${id}`;
  }

  /** Never throws: Slack is best-effort. */
  async #safe<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      this.#log(`${what} failed`, err);
      return null;
    }
  }

  // ── blocks ────────────────────────────────────────────────────────────────────────────────

  /** Ops grouped by system ("ERP · distru: Update PO-527 …"). */
  #opsBySystem(p: Proposal): string {
    const groups = new Map<string, string[]>();
    for (const op of p.ops) {
      const ref = this.#registry().connectorOf(op.action);
      const key = ref ? `${SYSTEM_LABEL[ref.system] ?? ref.system} · ${ref.id}` : op.action.split('.')[0] ?? op.action;
      const risk = op.risk === 'high' ? ' _(high risk)_' : '';
      groups.set(key, [...(groups.get(key) ?? []), `• ${mrkdwnEscape(op.summary ?? op.action)}${risk}`]);
    }
    return [...groups].map(([k, lines]) => `*${k}*\n${lines.join('\n')}`).join('\n');
  }

  approvalBlocks(p: Proposal, outcome?: string): Block[] {
    const reasons = p.policy.reasons.filter((r) => r.outcome !== 'pass').slice(0, 6);
    const suspicious = SuspiciousList.parse(p.meta.suspiciousText);
    const blocks: Block[] = [
      { type: 'header', text: { type: 'plain_text', text: `Approval needed: ${(p.title ?? 'Proposal').slice(0, 130)}`, emoji: false } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Total*\n${money(totalValue(p.ops))}` },
          { type: 'mrkdwn', text: `*Ops*\n${p.ops.length}` },
          { type: 'mrkdwn', text: `*Policy*\n${p.policy.outcome}` },
          { type: 'mrkdwn', text: `*Proposed by*\n${mrkdwnEscape(p.createdBy.label ?? p.createdBy.id)}` },
        ],
      },
      { type: 'section', text: { type: 'mrkdwn', text: this.#opsBySystem(p).slice(0, 2900) || '_no ops_' } },
    ];
    if (reasons.length) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Why it needs you*\n${reasons.map((r) => `• \`${r.rule}\` ${mrkdwnEscape(r.message)}`).join('\n')}`.slice(0, 2900) } });
    }
    if (suspicious.length) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Flagged: ${suspicious.length} piece(s) of untrusted text looked like instructions and were ignored.` }] });
    }
    if (outcome) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: outcome }] });
      blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open proposal' }, url: this.proposalUrl(p.id), action_id: 'proposal_open' }] });
    } else {
      blocks.push({
        type: 'actions',
        block_id: `proposal:${p.id}`,
        elements: [
          { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Approve' }, action_id: APPROVE_ACTION_ID, value: p.id },
          { type: 'button', style: 'danger', text: { type: 'plain_text', text: 'Reject' }, action_id: REJECT_ACTION_ID, value: p.id },
          { type: 'button', text: { type: 'plain_text', text: 'Open proposal' }, url: this.proposalUrl(p.id), action_id: 'proposal_open' },
        ],
      });
    }
    return blocks;
  }

  // ── posting ───────────────────────────────────────────────────────────────────────────────

  /** Posts the approval request; returns `{ channel, ts }` (null if Slack failed). */
  async postApprovalRequest(p: Proposal): Promise<{ channel: string; ts: string } | null> {
    return this.#safe('approval request', async () => {
      const res = await this.client.chat.postMessage({
        channel: this.#config.approvalsChannel,
        text: `Approval needed: ${p.title ?? p.id} (${money(totalValue(p.ops))})`,
        blocks: this.approvalBlocks(p),
      });
      return res.channel && res.ts ? { channel: res.channel, ts: res.ts } : null;
    });
  }

  /** Replaces the buttons with the outcome. */
  async updateApprovalMessage(channel: string, ts: string, p: Proposal, outcome: string): Promise<void> {
    await this.#safe('chat.update', () => this.client.chat.update({ channel, ts, text: `${p.title ?? p.id}: ${outcome}`, blocks: this.approvalBlocks(p, outcome) }));
  }

  async ephemeral(channel: string, user: string, text: string): Promise<void> {
    await this.#safe('chat.postEphemeral', () => this.client.chat.postEphemeral({ channel, user, text }));
  }

  /** The member's email (needs `users:read.email`), to map them to an Ops Agent user. */
  async userEmail(userId: string): Promise<string | null> {
    return (
      (await this.#safe('users.info', async () => {
        const res = await this.client.users.info({ user: userId });
        return res.user?.profile?.email ?? null;
      })) ?? null
    );
  }

  async notice(text: string): Promise<void> {
    await this.#safe('notification', () => this.client.chat.postMessage({ channel: this.#config.notifyChannel, text }));
  }

  async proposalCreated(p: Proposal): Promise<void> {
    const link = `<${this.proposalUrl(p.id)}|${mrkdwnEscape(p.title ?? p.id)}>`;
    if (p.status === 'pending_approval') {
      await this.postApprovalRequest(p);
      await this.notice(`Proposal created: ${link} (${p.ops.length} ops, ${money(totalValue(p.ops))}). Waiting for approval in ${this.#config.approvalsChannel}.`);
    } else if (p.status === 'auto_approved') {
      await this.notice(`Proposal auto-approved by policy: ${link} (${p.ops.length} ops, ${money(totalValue(p.ops))}).`);
    } else if (p.status === 'denied') {
      await this.notice(`Proposal denied by policy: ${link}. Nothing will be written.`);
    }
  }

  async proposalFinished(p: Proposal): Promise<void> {
    const link = `<${this.proposalUrl(p.id)}|${mrkdwnEscape(p.title ?? p.id)}>`;
    if (p.status === 'executed') {
      const verified = p.ops.every((op) => op.status === 'executed' && (op.result?.mismatches.length ?? 0) === 0);
      await this.notice(`Executed: ${link}. ${p.ops.length} op(s) written${verified ? ' and verified' : ', with verification mismatches'}.`);
    } else if (p.status === 'failed') {
      const failed = p.ops.find((op) => op.status === 'failed');
      await this.notice(`Execution failed: ${link}${failed ? ` at op #${failed.index} (${failed.action})` : ''}: ${p.execution?.error?.message ?? 'see the audit trail'}. Earlier ops are done; resume re-runs only what is left.`);
    } else if (p.status === 'rejected') {
      await this.notice(`Rejected: ${link} by ${p.decision?.by.label ?? p.decision?.by.id ?? 'an approver'}. Nothing was written.`);
    }
  }
}
