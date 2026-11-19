/**
 * Inbound webhook routes that are not part of the typed OpenAPI surface (provider-shaped bodies,
 * signature-authenticated, no session): Composio triggers and Slack interactivity. Mounted by
 * `src/app.ts`; the Distru webhook stays in `routes.ts` (documented in OpenAPI) and also goes
 * through a harness trigger.
 */
import { NotFoundError, systemClock, type Proposal } from '@ops/harness';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { SessionUser } from '../auth/session';
import { db } from '../db/client';
import { user } from '../db/schema';
import { env } from '../env';
import { appAuditSink, appHarness } from '../harness/app';
import { appConnectors, COMPOSIO_ID } from '../harness/registry';
import { inngest } from '../mastra/inngest';
import { appSlack } from '../slack';
import type { ApiServices } from './services';
import { createComposioWebhookRoutes } from './webhooks-composio';
import { createSlackWebhookRoutes } from './webhooks-slack';

/** Ops Agent user by email (case-insensitive), for mapping Slack members. */
export async function findUserByEmail(email: string): Promise<SessionUser | null> {
  const [row] = await db.select({ id: user.id, email: user.email, name: user.name, role: user.role }).from(user).where(eq(sql`lower(${user.email})`, email.toLowerCase()));
  return row ?? null;
}

export function createWebhookRoutes(services: Pick<ApiServices, 'proposals'>) {
  const app = new Hono();
  const log = (message: string, meta?: Record<string, unknown>) => console.warn(`[webhooks] ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}`);

  app.route(
    '/',
    createComposioWebhookRoutes({
      triggers: () => appConnectors.registry,
      audit: appAuditSink,
      clock: systemClock,
      secret: env.COMPOSIO_WEBHOOK_SECRET,
      connectorId: COMPOSIO_ID,
      send: async (event) => {
        await inngest.send({ name: event.name, id: event.id, data: event.data as Record<string, unknown> });
      },
      log,
    }),
  );

  if (appSlack) {
    app.route(
      '/',
      createSlackWebhookRoutes({
        triggers: () => appConnectors.registry,
        audit: appAuditSink,
        clock: systemClock,
        signingSecret: env.SLACK_SIGNING_SECRET,
        slack: appSlack,
        findUserByEmail,
        decide: async (proposalId, by, decision): Promise<Proposal> => {
          // Same path as the web UI: harness.decide with the user's principal, then resume the run.
          await services.proposals.decide(proposalId, by, { decision });
          return appHarness.get(proposalId);
        },
        getProposal: async (proposalId) => {
          try {
            return await appHarness.get(proposalId);
          } catch (err) {
            if (err instanceof NotFoundError) return null;
            throw err;
          }
        },
        log,
      }),
    );
  }
  return app;
}
