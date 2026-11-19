/**
 * Added in @ops/emulators (not in danwo): Composio's `GMAIL_NEW_GMAIL_MESSAGE` as a real poll
 * trigger over the Google emulator. Composio polls the connected Gmail account and fires the
 * trigger for every message that arrived since the last poll; `pollGmailTriggers` does the same
 * against the Google emulator's mailbox, so a message delivered there (by a test or a control
 * endpoint) reaches the project's webhook subscription as a signed `composio.trigger.message`.
 *
 * `grantGoogleAccess` issues a Google access token for a seeded account without the consent
 * screen, so a seeded Composio connected account can act on the Google emulator from the start.
 */
import type { Emulator } from "../define.ts"
import { gmailMailbox, type GmailMessage } from "../google/index.ts"
import { googleStore } from "../google/store.ts"
import { randomToken } from "../oauth/tokens.ts"
import type { DataKey } from "../store.ts"
import { ComposioEvents } from "./events.ts"
import { composioStore } from "./store.ts"

export const GMAIL_NEW_MESSAGE_TRIGGER = "GMAIL_NEW_GMAIL_MESSAGE"

/** The scopes Composio's managed Gmail + Calendar auth configs ask for. */
export const GOOGLE_COMPOSIO_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
  "openid",
  "email",
  "profile",
]

/**
 * Issues a non-expiring Google access token for the seeded account `email` (as if it had
 * consented to `clientId` for `scopes`) and returns it, for a Composio account's credentials.
 */
export function grantGoogleAccess(
  google: Pick<Emulator, "store">,
  email: string,
  options: { readonly clientId?: string; readonly scopes?: readonly string[] } = {},
): string {
  const tables = googleStore(google.store)
  const user = tables.users.findOneBy("email", email.toLowerCase()) ?? tables.users.findOneBy("email", email)

  if (!user) throw new Error(`grantGoogleAccess: no Google account ${email}`)

  return tables.tokens.insert({
    token: randomToken("ya29.", 48),
    kind: "access",
    clientId: options.clientId ?? "composio-managed.apps.googleusercontent.com",
    user: user.uid,
    scope: [...(options.scopes ?? GOOGLE_COMPOSIO_SCOPES)].join(" "),
    expiresAt: null,
    revoked: false,
    parent: null,
  }).token
}

/** Message ids each trigger instance has already seen, by instance id. */
const SEEN: DataKey<Record<string, string[]>> = { name: "composio.gmail_trigger_seen" }

/** The payload Composio's GMAIL_NEW_GMAIL_MESSAGE carries, for one message. */
export function gmailTriggerPayload(message: GmailMessage): Record<string, unknown> {
  const text = message.text ?? ""

  return {
    message_id: message.id,
    thread_id: message.threadId,
    sender: message.from,
    to: message.to,
    subject: message.subject,
    message_text: text,
    message_timestamp: message.date.toISOString(),
    label_ids: [...message.labelIds],
    attachment_list: [],
    preview: { subject: message.subject, body: text.slice(0, 200) },
  }
}

/** The Google account a Composio account's token acts as, when it was issued by `google`. */
function emailOf(google: Pick<Emulator, "store">, token: unknown): string | undefined {
  if (typeof token !== "string") return undefined

  const tables = googleStore(google.store)
  const issued = tables.tokens.findOneBy("token", token)

  return issued ? tables.users.findOneBy("uid", issued.user)?.email : undefined
}

/**
 * One poll: fires GMAIL_NEW_GMAIL_MESSAGE on every enabled instance for each message that arrived
 * in its account's mailbox (under `labelIds`, INBOX by default) since the instance's last poll. An
 * instance's first poll only takes note of what is already there, as Composio's does. Returns how
 * many fired.
 */
export function pollGmailTriggers(
  composio: Pick<Emulator, "store" | "outbox">,
  google: Pick<Emulator, "store" | "outbox">,
): number {
  const objects = composioStore(composio.store)
  const events = new ComposioEvents(composio.outbox, composio.store.clock)
  const seen = { ...composio.store.getData(SEEN) }
  let fired = 0

  for (const instance of objects.triggers.where(
    (t) => t.triggerName === GMAIL_NEW_MESSAGE_TRIGGER && t.disabledAt === null,
  )) {
    const account = objects.accounts.get(instance.accountId)
    const email = account?.status === "ACTIVE" ? emailOf(google, account.val["access_token"]) : undefined

    if (!account || !email) continue

    const label = typeof instance.config["labelIds"] === "string" ? instance.config["labelIds"] : "INBOX"
    const messages = gmailMailbox(google, email).messages(label).reverse()
    const before = seen[instance.id]

    seen[instance.id] = messages.map((m) => m.id)
    if (before === undefined) continue

    for (const message of messages.filter((m) => !before.includes(m.id))) {
      events.trigger(instance, account, gmailTriggerPayload(message))
      fired++
    }
  }

  composio.store.setData(SEEN, seen)

  return fired
}
