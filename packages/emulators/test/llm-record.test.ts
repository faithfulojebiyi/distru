import { once } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import { createEmulator } from "../src/define.ts"
import { llm, llmCalls, seedLlm } from "../src/llm/index.ts"
import { listeningPort } from "../src/net.ts"
import { fakeKey } from "./fake-key.ts"
import { anthropicClient, openaiClient } from "./llm-client.ts"

const REAL_KEY = fakeKey("sk-", "proj-USERSOWNREALKEY0123456789abcdef")

/** What the stand-in for the real provider was asked. */
interface Asked {
  readonly authorization: string
  readonly body: Record<string, unknown>
}

const asked: Asked[] = []
const anthropicAsked: Asked[] = []
let upstream: Server
let upstreamUrl: string
let dir: string

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = ""

  for await (const chunk of req) text += String(chunk)

  const parsed: unknown = JSON.parse(text)

  return typeof parsed === "object" && parsed !== null
    ? Object.fromEntries(Object.entries(parsed))
    : {}
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "danwo-llm-record-"))
  upstream = createServer((req, res) => {
    void bodyOf(req).then((body) => {
      if (req.url === "/v1/messages") {
        anthropicAsked.push({ authorization: String(req.headers["x-api-key"] ?? ""), body })
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            id: "msg_real",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-5",
            content: [{ type: "tool_use", id: "toolu_real", name: "lookup_order", input: { order: 7 } }],
            stop_reason: "tool_use",
            stop_sequence: null,
            usage: { input_tokens: 1200, output_tokens: 40, cache_read_input_tokens: 300 },
          }),
        )
        return
      }
      asked.push({ authorization: req.headers.authorization ?? "", body })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          id: "chatcmpl-real",
          object: "chat.completion",
          created: 0,
          model: "gpt-5-mini",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "Paris is the capital of France.",
                refusal: null,
              },
              finish_reason: "stop",
              logprobs: null,
            },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 7, total_tokens: 16 },
        }),
      )
    })
  })
  upstream.listen(0, "127.0.0.1")
  await once(upstream, "listening")
  upstreamUrl = `http://127.0.0.1:${listeningPort(upstream)}`
})

afterAll(async () => {
  upstream.close()
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe("recording", () => {
  it("asks the real provider once with the user's key, saves the answer without it, then replays it", async () => {
    const file = join(dir, "llm-scripts.json")
    const recording = createEmulator(llm)

    seedLlm(recording.store, {
      unscripted: "fail",
      record: { file, keys: { openai: REAL_KEY }, upstreams: { openai: upstreamUrl } },
    })

    const ask = (emulator: typeof recording) =>
      openaiClient(emulator).chat.completions.create({
        model: "gpt-5-mini",
        stream: true,
        messages: [{ role: "user", content: "What is the capital of France?" }],
      })
    let first = ""

    for await (const chunk of await ask(recording)) first += chunk.choices[0]?.delta.content ?? ""

    expect(first).toBe("Paris is the capital of France.")
    expect(asked).toHaveLength(1)
    expect(asked[0]?.authorization).toBe(`Bearer ${REAL_KEY}`)
    expect(asked[0]?.body.stream).toBeUndefined()

    const saved = await readFile(file, "utf8")

    expect(saved).toContain("Paris is the capital of France.")
    expect(saved).not.toContain("USERSOWNREALKEY")
    expect(JSON.stringify(recording.snapshot())).not.toContain("USERSOWNREALKEY")

    const replaying = createEmulator(llm)

    seedLlm(replaying.store, { unscripted: "fail", record: { file } })

    let again = ""

    for await (const chunk of await ask(replaying)) again += chunk.choices[0]?.delta.content ?? ""

    expect(again).toBe("Paris is the capital of France.")
    expect(asked).toHaveLength(1)
    expect(llmCalls(replaying).last()?.script).toBe("recorded gpt-5-mini")
  })
})

// Added in @ops/emulators: Anthropic recordings keep the provider's real token counts.
describe("recording Anthropic", () => {
  it("records a tool call with the real usage once, then replays both without the network", async () => {
    const file = join(dir, "anthropic-scripts.json")
    const key = fakeKey("sk-", "ant-api03-USERSOWNREALKEY0123456789abcdef")
    const recording = createEmulator(llm)

    seedLlm(recording.store, {
      unscripted: "fail",
      record: { file, keys: { anthropic: key }, upstreams: { anthropic: upstreamUrl } },
    })

    const ask = (emulator: typeof recording) =>
      anthropicClient(emulator).messages.create({
        model: "claude-sonnet-5",
        max_tokens: 200,
        system: "You are a support agent.",
        tools: [{ name: "lookup_order", input_schema: { type: "object", properties: {} } }],
        messages: [{ role: "user", content: "where is order 7?" }],
      })
    const first = await ask(recording)

    expect(anthropicAsked).toHaveLength(1)
    expect(anthropicAsked[0]?.authorization).toBe(key)
    expect(first.usage.input_tokens).toBe(1500)
    expect(first.usage.output_tokens).toBe(40)

    const saved = await readFile(file, "utf8")

    expect(saved).not.toContain("USERSOWNREALKEY")

    const replaying = createEmulator(llm)

    seedLlm(replaying.store, { unscripted: "fail", record: { file } })

    const again = await ask(replaying)
    const use = again.content.find((block) => block.type === "tool_use")

    expect(use?.type === "tool_use" && use.input).toEqual({ order: 7 })
    expect(again.usage.input_tokens).toBe(1500)
    expect(again.usage.output_tokens).toBe(40)
    expect(anthropicAsked).toHaveLength(1)
    expect(llmCalls(replaying).last()?.usage).toEqual({ input: 1500, output: 40 })
  })
})
