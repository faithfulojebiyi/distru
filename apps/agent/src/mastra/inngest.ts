import { init } from '@mastra/inngest';
import { Inngest } from 'inngest';

/**
 * Inngest client for durable workflow execution. Mode comes from the environment:
 * `INNGEST_DEV=1` → local Dev Server (http://localhost:8288, no signing);
 * unset → Inngest Cloud (requires INNGEST_EVENT_KEY + INNGEST_SIGNING_KEY).
 */
export const inngest = new Inngest({ id: 'ops-agent' });

/** Inngest-backed workflow primitives: every step is memoized and retried by Inngest. */
export const inngestWorkflowKit = init(inngest);
export const { createWorkflow, createStep } = inngestWorkflowKit;

/** Event that starts a restock run (sent by the Distru webhook route; consumed by `restockOnEvent`). */
export const RESTOCK_REQUESTED_EVENT = 'ops/restock.requested';
