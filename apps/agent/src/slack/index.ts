import { db } from '../db/client';
import { env } from '../env';
import { appConnectors } from '../harness/registry';
import { noopNotifier, SlackApprovals, type ProposalNotifier } from './approvals';
import { DrizzleSlackMessageStore } from './message-store';

/**
 * The process-wide Slack approvals client (emulator by default: SLACK_API_URL), or null when
 * SLACK_BOT_TOKEN is empty. `appNotifier` is what the workflows call (a no-op without Slack).
 */
export const appSlack: SlackApprovals | null = env.SLACK_BOT_TOKEN
  ? new SlackApprovals(
      {
        token: env.SLACK_BOT_TOKEN,
        ...(env.SLACK_API_URL ? { apiUrl: env.SLACK_API_URL } : {}),
        approvalsChannel: env.SLACK_APPROVALS_CHANNEL,
        notifyChannel: env.SLACK_NOTIFY_CHANNEL,
        webBaseUrl: env.WEB_BASE_URL ?? env.WEB_ORIGIN[0] ?? 'http://localhost:3050',
      },
      // Posted message ts per proposal in Postgres: a retried step updates instead of posting again.
      { registry: () => appConnectors.registry, messages: new DrizzleSlackMessageStore(db) },
    )
  : null;

export const appNotifier: ProposalNotifier = appSlack ?? noopNotifier;
