import { init } from '@mastra/inngest';
import { Inngest } from 'inngest';

/**
 * Inngest client for durable workflow execution. Mode comes from the environment:
 * `INNGEST_DEV=1` → local Dev Server (http://localhost:8288, no signing);
 * unset → Inngest Cloud (requires INNGEST_EVENT_KEY + INNGEST_SIGNING_KEY).
 */
export const inngest = new Inngest({ id: 'ops-agent' });

/** Inngest-backed workflow primitives: every step is memoized and retried by Inngest. */
export const { createWorkflow, createStep } = init(inngest);
