import type { Composio } from "@composio/core"
import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import {
  connectComposioBackends,
  gmailTriggerPayload,
  grantGoogleAccess,
  pollGmailTriggers,
  seedComposio,
} from "../src/composio/index.ts"
import { composio } from "../src/composio/index.ts"
import { createEmulator, type Emulator } from "../src/define.ts"
import { gmailMailbox, google, seedGoogle } from "../src/google/index.ts"
import { ManualClock } from "../src/time.ts"
import { router, sdk } from "./composio-client.ts"

/** Tests for what @ops/emulators added: Gmail read-one/reply tools and the polled Gmail trigger. */

const BUYER = "purchasing@goldencoastdistro.com"
const VENDOR = "orders@mojaveprerollco.com"
const WEBHOOK_SECRET = "whsec-test"
const run = { userId: "golden-coast", dangerouslySkipVersionCheck: true } as const

let gmail: Emulator
let project: Emulator
let client: Composio
let restore: () => void
const delivered: { headers: Record<string, string>; body: string }[] = []
const clock = new ManualClock(new Date())

beforeEach(() => {
  delivered.length = 0
  gmail = createEmulator(google)
  seedGoogle(gmail.store, { users: [{ email: BUYER, name: "Purchasing" }, { email: VENDOR, name: "Mojave Orders" }] })
  project = createEmulator(composio, {
    clock: clock.clock,
    timer: clock.timer,
    fetch: async (input, init) => {
      const request = new Request(input, init)

      delivered.push({ headers: Object.fromEntries(request.headers), body: await request.text() })

      return new Response(null, { status: 200 })
    },
  })
  seedComposio(project.store, {
    connectedAccounts: [
      {
        id: "ca_gmail",
        userId: "golden-coast",
        toolkit: "gmail",
        credentials: { access_token: grantGoogleAccess(gmail, BUYER) },
        label: BUYER,
      },
    ],
    triggers: [{ id: "ti_gmail_new", trigger: "GMAIL_NEW_GMAIL_MESSAGE", connectedAccount: "ca_gmail" }],
    webhook: { url: "https://agent.test/api/webhooks/composio", secret: WEBHOOK_SECRET },
  })
  connectComposioBackends(project, { google: gmail })

  const started = sdk(router({ "backend.composio.dev": project }))

  client = started.client
  restore = () => started.restore()
})

afterEach(() => restore())

describe("Gmail tools added for the vendor-reply loop", () => {
  it("fetches a message and a thread, and replies in the thread", async () => {
    const sent = await client.tools.execute("GMAIL_SEND_EMAIL", {
      ...run,
      arguments: { recipient_email: VENDOR, subject: "Purchase order PO-527", body: "Please confirm 312 x PRE-BD-1G." },
    })
    const sentId = String((sent.data as { id: string }).id)
    const original = gmailMailbox(gmail, BUYER).sent()[0]

    gmailMailbox(gmail, BUYER).deliver({
      from: VENDOR,
      to: BUYER,
      subject: "Re: Purchase order PO-527",
      text: "We can only ship 200 of the 312 units.",
      inReplyTo: original?.header("message-id") ?? "",
    })

    const reply = gmailMailbox(gmail, BUYER).inbox()[0]

    expect(reply?.threadId).toBe(original?.threadId ?? "")

    const one = await client.tools.execute("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", { ...run, arguments: { message_id: sentId } })

    expect(one.successful).toBe(true)
    expect(one.data).toMatchObject({ messageId: sentId, subject: "Purchase order PO-527", to: VENDOR })

    const thread = await client.tools.execute("GMAIL_FETCH_MESSAGE_BY_THREAD_ID", {
      ...run,
      arguments: { thread_id: reply?.threadId ?? "" },
    })
    const subjects = (thread.data as { messages: { subject: string }[] }).messages.map((m) => m.subject)

    expect(subjects).toEqual(["Purchase order PO-527", "Re: Purchase order PO-527"])

    const answered = await client.tools.execute("GMAIL_REPLY_TO_THREAD", {
      ...run,
      arguments: { thread_id: reply?.threadId ?? "", recipient_email: VENDOR, message_body: "Thanks, ship the 200." },
    })

    expect(answered.successful).toBe(true)

    const [latest] = gmailMailbox(gmail, BUYER).sent()

    expect(latest?.subject).toBe("Re: Purchase order PO-527")
    expect(latest?.threadId).toBe(original?.threadId ?? "")
    expect(latest?.header("in-reply-to")).toBe(reply?.header("message-id"))
  })
})

describe("GMAIL_NEW_GMAIL_MESSAGE, polled over the Google emulator", () => {
  it("baselines on the first poll, then fires a signed webhook per new inbox message", async () => {
    gmailMailbox(gmail, BUYER).deliver({ from: VENDOR, to: BUYER, subject: "Old", text: "Already here" })
    expect(pollGmailTriggers(project, gmail)).toBe(0)

    const message = gmailMailbox(gmail, BUYER).deliver({ from: VENDOR, to: BUYER, subject: "PO-527 update", text: "Rest ETA Dec 2" })

    expect(pollGmailTriggers(project, gmail)).toBe(1)
    expect(pollGmailTriggers(project, gmail)).toBe(0)
    clock.advance(1)
    await project.webhooks?.idle()

    const [webhook] = delivered
    const verified = await client.triggers.verifyWebhook({
      payload: webhook?.body ?? "",
      signature: webhook?.headers["webhook-signature"] ?? "",
      id: webhook?.headers["webhook-id"] ?? "",
      timestamp: webhook?.headers["webhook-timestamp"] ?? "",
      secret: WEBHOOK_SECRET,
    })

    expect(verified.payload.triggerSlug).toBe("GMAIL_NEW_GMAIL_MESSAGE")
    expect(verified.payload.metadata.connectedAccount.id).toBe("ca_gmail")
    expect(verified.payload.payload).toEqual(gmailTriggerPayload(message))
    expect(verified.payload.payload?.["message_text"]).toBe("Rest ETA Dec 2")
  })
})
