# @ops/connector-composio

Composio-hosted tools (Gmail, Google Calendar, Google Sheets, …) as a governed harness connector, plus Composio
**triggers** (signed webhooks) verified and normalized into typed events. Built on
`@composio/core` 0.25.0.

```ts
import { Registry, createHarness } from '@ops/harness';
import { createComposioConnector, composioConfigFromEnv, composioErrorClassifier } from '@ops/connector-composio';

const composio = await createComposioConnector(composioConfigFromEnv()); // or { apiKey, baseURL?, userId, toolkits, tools?, classify? }
const registry = Registry.fromConnectors([distru, composio.connector]);
const ctx = { connectors: { ...distruCtx.connectors, ...composio.context.connectors } };
const harness = createHarness({ registry, store, audit, policyRules, errors: composioErrorClassifier });
```

## Config

| Option / env | Meaning |
|---|---|
| `apiKey` / `COMPOSIO_API_KEY` | Composio project key (`ak_…`) |
| `baseURL` / `COMPOSIO_BASE_URL` | **Emulator only** (`http://localhost:4700`, see `apps/emulators`). Unset = real Composio. |
| `userId` / `COMPOSIO_USER_ID` | Composio user the connected accounts belong to (default `golden-coast`) |
| `connectedAccountIds` / `COMPOSIO_GMAIL_ACCOUNT_ID`, `COMPOSIO_GOOGLECALENDAR_ACCOUNT_ID` | Optional pins per toolkit |
| `toolkits` / `COMPOSIO_TOOLKITS` | default `gmail,googlecalendar,googlesheets` |
| `spreadsheets` / `COMPOSIO_GOOGLESHEETS_SPREADSHEETS` | Known spreadsheets by name (`Name=id`, comma-separated); a leading `+` puts one on the `sheets.append_rows` allowlist |
| `tools` | Allow-list of slugs (default: every known tool of the toolkits). Unknown slugs are bridged generically. |
| `classify(tool)` | Override `'read' \| 'write' \| { kind, risk }` |
| `toolkitVersions` | Pin toolkit versions for production; without it tools run at `latest` with `dangerouslySkipVersionCheck` |
| `readOnly`, `client`, `id`, `system` | read-only bridge; inject a `ComposioToolsClient`; connector id (default `composio`); system (default `other`) |

Switching to real Composio = real API key, no `baseURL`, the real user id, accounts connected in
Composio, and (for triggers) the trigger + webhook subscription created in the Composio dashboard.

## Tools

Registry names are `composio.<slug lower-cased>` → tools `composio_<…>` / `propose_composio_<…>`, except the
Sheets tools: `composio.sheets.read_rows` / `composio.sheets.append_rows`.

| Composio slug | Kind | Risk | Notes |
|---|---|---|---|
| `GMAIL_FETCH_EMAILS` | read | | `{ query?, max_results≤25, label_ids? }` → trimmed summaries |
| `GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID` | read | | one message incl. body (≤4000 chars) |
| `GMAIL_FETCH_MESSAGE_BY_THREAD_ID` | read | | whole thread |
| `GOOGLECALENDAR_EVENTS_LIST` | read | | |
| `GMAIL_SEND_EMAIL` | write | **high** | never auto-approved; `moneyless` (value 0, so total-value caps still evaluate) |
| `GMAIL_REPLY_TO_THREAD` | write | **high** | never auto-approved; `moneyless` |
| `GOOGLECALENDAR_CREATE_EVENT` | write | medium | `valueOf = 0` so `auto_approve_below { max_risk: 'medium' }` can apply |
| `GOOGLESHEETS_BATCH_GET` → `sheets.read_rows` | read | | `{ spreadsheet (id or known name), range?, max_rows }` → rows, each wrapped as untrusted text (cells joined with ` \| `) |
| `GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND` → `sheets.append_rows` | write | medium | allowlisted spreadsheets only (refused at propose otherwise); `moneyless`; undoable |
| anything else allowed | by name (`_FETCH/_GET/_LIST/_SEARCH/_FIND` = read; else write, high if it sends/posts/deletes/invites) | | loose input; writes flagged `unverified` + `dedupeByExecutorOnly` (`bridge.tools`) |

**Writes**: `plan` = the exact tool arguments (what the approver sees, as an all-added diff);
`execute` = `tools.execute` with an idempotency marker appended: a `Ref: opsidem<24 hex>` footer
(hash of the harness key) on the email body / event description. `findByIdempotencyKey` searches
`in:sent opsidem…` (Gmail) or events `q=opsidem…` (Calendar), so a crash after the send dedupes on
resume; `verify` reads the message back (`SENT` label, To recipients, subject or thread id) or the
event (summary, start, attendees). The footer is the one thing added to what the approver saw.

**Sheets** has no searchable text, so the marker is one extra trailing cell per appended row (the
reorder log's `Ref` column). `findByIdempotencyKey` scans the allowlisted spreadsheets' tabs
(`GOOGLESHEETS_GET_SPREADSHEET_INFO` + `GOOGLESHEETS_BATCH_GET`) for it; `verify` reads the appended
range back cell by cell (numbers compared numerically). **Undo** (`compensate`) clears exactly that range
with `GOOGLESHEETS_CLEAR_VALUES` after checking it still holds the rows we wrote with the marker: the rows
stay, emptied, and a range someone has since edited is refused (clear it by hand).

**Untrusted text**: sender header (incl. display name), subject, snippet, body and event
title/description are wrapped as `{ untrusted_text, source, suspicious }` (same policy as
`connector-distru/src/untrusted.ts`); ids, dates, label ids and parsed addresses are plain. Each
message carries `suspicious: true` when any of its text looks like a prompt injection.

## Triggers

```ts
import { verifyComposioWebhook, normalizeComposioEvent, inngestEventFor } from '@ops/connector-composio';

// POST /api/webhooks/composio  (read the RAW body; do not JSON-parse first)
const raw = await c.req.text();
const v = await verifyComposioWebhook(raw, c.req.raw.headers, env.COMPOSIO_WEBHOOK_SECRET);
if (!v.ok) return c.json({ error: v.reason }, 401);     // missing_headers | bad_signature | stale_timestamp | bad_payload
const event = normalizeComposioEvent(v.raw);              // zod-validated
await inngest.send(inngestEventFor(event));               // { name: 'composio/gmail.new_message', id: 'composio:<webhook-id>', data: event }
return c.json({ ok: true });
```

`verifyComposioWebhook` uses the SDK's own verifier (`triggers.verifyWebhook`, HMAC-SHA256 over
`id.timestamp.body`, 300 s tolerance) and never throws. `normalizeComposioEvent` accepts the raw V3
body or the SDK's normalized payload and returns

```ts
{ source: 'composio', trigger: 'gmail.new_message', eventId, triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE', triggerId,
  connectedAccountId, userId, occurredAt,
  data: { messageId, threadId, fromAddress, from: UntrustedText, to: string[], subject: UntrustedText,
          snippet: UntrustedText /* ≤500 chars */, labelIds, suspicious } }
```

(other trigger slugs → `trigger: 'other'` with the payload as `data`).

**Harness trigger.** `composioGmailNewMessageTrigger(connectorId = 'composio')` (and
`gmailNewMessageTrigger`) is a harness `defineTrigger`: id `<connector id>.gmail.new_message`, event
`composio/gmail.new_message`, secret `COMPOSIO_WEBHOOK_SECRET`, `untrustedFields` = from / subject /
snippet. The connector registers it when `gmail` is among the toolkits, so an app can simply

```ts
const r = await ingestWebhook(registry, 'composio.gmail.new_message', raw, headers, { COMPOSIO_WEBHOOK_SECRET }, { audit });
if (r.status === 'accepted') await inngest.send(r.event); // id 'composio.gmail.new_message:<webhook-id>'
```

(forged / tampered / stale → `rejected` 401 + `trigger.rejected` audit event).

## Tests

`bun test` runs against the in-process emulator world (`@ops/emulators-server`) over loopback, with
the real SDK pointed at it: listing, untrusted wrapping, injection flagging, send/reply/calendar
through propose → policy → approve → execute → verify → re-execute (no second send), crash-after-send
dedupe by marker, and signed webhook verify (valid, forged, wrong secret, tampered, missing headers)
+ normalization, and the harness trigger through `ingestWebhook` (accepted, forged, missing secret, audited). `bunx tsc --noEmit`.

**Subpath `@ops/connector-composio/untrusted`**: `untrusted`, `looksLikeInjection`, `UntrustedTextSchema`
without the Composio SDK, so other packages wrap external text with the same policy (the context layer's
semantic recall wraps every recalled passage with it). `RawGmailMessageSchema` and `messagesOf` are exported
for readers that need the full message view (recall's mailbox indexer).
