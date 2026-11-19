import { createRubricScorer } from '@mastra/evals/scorers/prebuilt';
import type { MastraModelConfig } from '@mastra/core/llm';
import type { JudgeVerdict } from './assertions';

/**
 * Optional LLM-as-judge for Copilot answer quality: Mastra's rubric scorer (`@mastra/evals`), which
 * returns 1 only when every criterion holds and lists a verdict per criterion. The judge model goes
 * through the same LLM gateway as the agents, so judge calls are recorded and replayed offline too.
 */
export async function judgeAnswer(model: MastraModelConfig, question: string, answer: string, criteria: readonly string[]): Promise<JudgeVerdict> {
  const scorer = createRubricScorer({ model, criteria: criteria.map((description) => ({ description })) });
  const result = await scorer.run({ input: { originalTask: question, currentText: answer }, output: answer });
  return { score: result.score ?? 0, reason: typeof result.reason === 'string' ? result.reason : '' };
}
