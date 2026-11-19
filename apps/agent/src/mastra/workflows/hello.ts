import { z } from 'zod';
import { createStep, createWorkflow } from '../inngest';

/**
 * Smoke-test workflow proving suspend → resume through Inngest:
 *   greet → awaitApproval (suspends until resumed with { approved }) → done.
 */
const greet = createStep({
  id: 'greet',
  inputSchema: z.object({ name: z.string() }),
  outputSchema: z.object({ greeting: z.string() }),
  execute: async ({ inputData }) => ({ greeting: `Hello, ${inputData.name}!` }),
});

const awaitApproval = createStep({
  id: 'await-approval',
  inputSchema: z.object({ greeting: z.string() }),
  outputSchema: z.object({ greeting: z.string(), approved: z.boolean(), approvedBy: z.string() }),
  suspendSchema: z.object({ message: z.string() }),
  resumeSchema: z.object({ approved: z.boolean(), approvedBy: z.string().default('unknown') }),
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) {
      return await suspend({ message: `Approve greeting "${inputData.greeting}"?` });
    }
    return { greeting: inputData.greeting, approved: resumeData.approved, approvedBy: resumeData.approvedBy };
  },
});

export const helloWorkflow = createWorkflow({
  id: 'hello',
  inputSchema: z.object({ name: z.string() }),
  outputSchema: z.object({ greeting: z.string(), approved: z.boolean(), approvedBy: z.string() }),
})
  .then(greet)
  .then(awaitApproval)
  .commit();
