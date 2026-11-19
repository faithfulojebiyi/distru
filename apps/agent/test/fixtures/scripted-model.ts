import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';

/**
 * Deterministic stand-in for an LLM: a script looks at the conversation so far (user prompt + tool
 * results) and returns either tool calls or the final structured-output JSON. No network, no key.
 */
export interface ToolResult {
  toolName: string;
  output: unknown;
}

export interface ScriptCall {
  /** All user text in the conversation (the task prompt). */
  prompt: string;
  /** Tool results so far, in order. */
  results: ToolResult[];
  /** 0 for the first model call, +1 per previous assistant turn. */
  step: number;
  /** Tool names offered to the model. */
  tools: string[];
}

export type ScriptTurn = { tools: Array<{ name: string; args: Record<string, unknown> }> } | { final: unknown } | { text: string };
export type Script = (call: ScriptCall) => ScriptTurn;

export const USAGE = { inputTokens: 100, outputTokens: 20, totalTokens: 120 };

type Part = Record<string, unknown>;
// agent.generate() drives doGenerate; streaming isn't used by the workflow.
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseCall(options: { prompt: unknown; tools?: Array<{ name: string }> }): ScriptCall {
  const messages = Array.isArray(options.prompt) ? options.prompt.filter(isRecord) : [];
  const texts: string[] = [];
  const results: ToolResult[] = [];
  let step = 0;
  for (const m of messages) {
    const parts: Part[] = Array.isArray(m.content) ? m.content.filter(isRecord) : [];
    if (m.role === 'user') for (const p of parts) if (p.type === 'text' && typeof p.text === 'string') texts.push(p.text);
    if (m.role === 'assistant') step++;
    if (m.role === 'tool') {
      for (const p of parts) {
        if (p.type !== 'tool-result' || typeof p.toolName !== 'string') continue;
        const out = isRecord(p.output) ? p.output : {};
        let value: unknown = out.value;
        if (out.type === 'text' && typeof value === 'string') {
          try {
            value = JSON.parse(value);
          } catch {
            /* keep text */
          }
        }
        results.push({ toolName: p.toolName, output: value });
      }
    }
  }
  return { prompt: texts.join('\n'), results, step, tools: (options.tools ?? []).map((t) => t.name) };
}

let callSeq = 0;

export function scriptedModel(name: string, script: Script) {
  const generate = (options: { prompt: unknown; tools?: Array<{ name: string }> }) => {
    const turn = script(parseCall(options));
    const id = `${name}-${++callSeq}`;
    if ('tools' in turn) {
      return {
        content: turn.tools.map((t, i) => ({ type: 'tool-call' as const, toolCallId: `${id}-tc${i}`, toolName: t.name, input: JSON.stringify(t.args) })),
        finishReason: 'tool-calls' as const,
      };
    }
    const text = 'final' in turn ? JSON.stringify(turn.final) : turn.text;
    return { content: [{ type: 'text' as const, text }], finishReason: 'stop' as const };
  };

  return new MastraLanguageModelV2Mock({
    provider: 'scripted',
    modelId: name,
    doGenerate: async (options) => {
      const { content, finishReason } = generate(options);
      return { content, finishReason, usage: USAGE, warnings: [], request: {}, response: { id: `resp-${callSeq}`, modelId: name, timestamp: new Date(0) } };
    },
  });
}

// ── prompt helpers ───────────────────────────────────────────────────────────────────────────────

/** JSON that follows `label` on its line (prompts put one JSON value per line). */
export function jsonAfter<T = unknown>(prompt: string, label: string): T | null {
  const line = prompt.split('\n').find((l) => l.includes(label));
  if (!line) return null;
  return JSON.parse(line.slice(line.indexOf(label) + label.length).trim()) as T;
}

export function match(prompt: string, re: RegExp): string | null {
  return re.exec(prompt)?.[1] ?? null;
}

export function resultOf(results: readonly ToolResult[], toolName: string): Record<string, unknown> | null {
  const found = [...results].reverse().find((r) => r.toolName === toolName);
  return found && isRecord(found.output) ? found.output : null;
}

export function resultsOf(results: readonly ToolResult[], toolName: string): Record<string, unknown>[] {
  return results.filter((r) => r.toolName === toolName && isRecord(r.output)).map((r) => r.output as Record<string, unknown>);
}
