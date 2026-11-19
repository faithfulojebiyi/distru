# @ops/emulators

> Copied from danwo/packages/emulators (Apache-2.0, same author). See `LICENSE`.

In-process provider emulators: `defineEmulator`/`createEmulator`, a snapshot-able store, an outbox
plus a webhook dispatcher (signing, retries, fault injection), OAuth building blocks, and four
providers, each speaking the real wire protocol so the official SDKs work against it unchanged.

| Provider | What it emulates | Official client in tests |
|---|---|---|
| `composio` | `backend.composio.dev` v3/v3.1: toolkits, tools, `tools/execute`, auth configs, connected accounts (hosted connect links), trigger instances, the project webhook subscription with Standard-Webhooks signatures that `@composio/core`'s `triggers.verifyWebhook` accepts | `@composio/core` 0.25.0 |
| `google` | OAuth (account chooser, PKCE, refresh, revoke), Gmail (messages, threads, labels, drafts, history, search, push), Calendar (events, lists, watch), Drive | `googleapis` |
| `slack` | OAuth v2 installs, Web API with scope checks, Events API, interactivity (`block_actions`, modals), slash commands, signed deliveries | `@slack/web-api`, `@slack/bolt` |
| `resend` | Emails, domains, API keys, signed webhooks | `resend` |
| `llm` | Model APIs on their real hosts (Anthropic Messages, OpenAI, AI Gateway, Gemini, Perplexity, Bedrock): scripted replies, faults, token/cost accounting, and **record/replay** of real calls | `@anthropic-ai/sdk`, `openai` |

Composio is connected to the Google and Slack emulators with `connectComposioBackends(composio,
{ google, slack })`: a `GMAIL_SEND_EMAIL` lands in the Google emulator's mailbox, and a mail sent
to another seeded Google account is delivered to its inbox.

## What was kept / trimmed / added

- **Kept** (unchanged apart from import tidying): core (`define`, `http`, `store`, `outbox`,
  `webhooks`, `time`, `json`, `errors`, `objects`, `poll`, `random`, `svix`, `sockets`, `net`,
  `html`), `oauth/`, `composio/`, `google/`, `slack/`, `resend/`.
- **Trimmed**: every other provider (auth0, bachs, clerk, flutterwave, github, microsoft,
  nango, novu, nylas, paystack, pusher, s3, stripe, tiptap, twilio, unipile), the Composio GitHub and
  Microsoft backends (those toolkits now answer with seeded/sample data), `cors.ts`, `hs256.ts`,
  `oauth/upstream-profile.ts`, and their tests.
- **Added** (marked "Added in @ops/emulators" in the source):
  - Composio Gmail tools `GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID`, `GMAIL_FETCH_MESSAGE_BY_THREAD_ID`,
    `GMAIL_REPLY_TO_THREAD` (catalog + Google backend; real Composio slugs and argument names).
  - `src/composio/gmail-trigger.ts`: `pollGmailTriggers(composio, google)` makes
    `GMAIL_NEW_GMAIL_MESSAGE` a real poll trigger over the Google mailbox (first poll baselines, each
    later poll fires one signed `composio.trigger.message` per new INBOX message);
    `gmailTriggerPayload`; `grantGoogleAccess(google, email)` issues a non-expiring Google token so
    a *seeded* Composio connected account can act on Gmail without the consent screen.
  - `FetchFn` type for `EmulatorOptions.fetch` (bun's `typeof fetch` has `preconnect`).
  - `src/llm/` (added later, copied whole from danwo) with three changes, used by `@ops/evals`:
    recordings save the provider's real token usage and replays report it (`LlmReply.usage`,
    `usageFromAnswer`); Anthropic answers drop `citations: null` on the wire (the real API omits it and
    the AI SDK provider bundled in Mastra rejects `null`); `LlmRecordOptions.fetch` is a `FetchFn`.
    Tests: `llm-anthropic.test.ts`, `llm-record.test.ts` (plus an Anthropic record/usage replay case).

## Use

```ts
import { createEmulator, composio, google, seedGoogle, seedComposio, connectComposioBackends, grantGoogleAccess, pollGmailTriggers } from '@ops/emulators';

const gmail = createEmulator(google);
seedGoogle(gmail.store, { users: [{ email: 'purchasing@goldencoastdistro.com' }] });
const project = createEmulator(composio);
seedComposio(project.store, {
  apiKeys: ['ak_test'],
  connectedAccounts: [{ id: 'ca_gmail', userId: 'golden-coast', toolkit: 'gmail', credentials: { access_token: grantGoogleAccess(gmail, 'purchasing@goldencoastdistro.com') } }],
  triggers: [{ trigger: 'GMAIL_NEW_GMAIL_MESSAGE', connectedAccount: 'ca_gmail' }],
  webhook: { url: 'http://localhost:4111/api/webhooks/composio', secret: 'whsec_…' },
});
connectComposioBackends(project, { google: gmail });
// project.fetch(request) answers https://backend.composio.dev/api/v3/...; serve it with Bun.serve,
// or use apps/emulators, which does all of this for the Ops Agent demo.
```

## Tests

`bun test` (ported from vitest to `bun:test`; `vi.waitFor` → `test/helpers.ts`), `bunx tsc --noEmit`.
Bun 1.4 note: `toMatchObject` with an asymmetric matcher (`expect.stringMatching`) **replaces the
matched value in the received object**, so assert on values you reuse with `toMatch`/`toBe` instead.
