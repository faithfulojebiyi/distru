# @ops/connector-email

Outgoing vendor email as a governed harness connector (system `email`). The agent can only
*propose* an email; a human always approves the exact message before anything is sent.

```ts
import { BUILTIN_POLICY_RULES, PolicyEngine, Registry, createHarness } from '@ops/harness';
import { distruConnector, createDistruContextFromEnv } from '@ops/connector-distru';
import { emailConnector, createEmailContextFromEnv, emailErrorClassifier, emailRecipientDomainsRule } from '@ops/connector-email';

const registry = Registry.fromConnectors([distruConnector, emailConnector]);   // Registry<DistruCtx & EmailCtx>
const ctx = { connectors: { ...createDistruContextFromEnv().connectors, ...createEmailContextFromEnv().connectors } };
const harness = createHarness({
  registry, store, audit, policyRules, errors: emailErrorClassifier,
  policyEngine: new PolicyEngine([...BUILTIN_POLICY_RULES, emailRecipientDomainsRule]),
});
```

## Config

| Env | Effect |
|---|---|
| (none) | `OutboxTransport`: in-memory mock outbox. Nothing leaves the process. Default for dev, tests, evals. |
| `RESEND_API_KEY` + `EMAIL_FROM` | `ResendTransport` (fetch, no SDK). `EMAIL_FROM` is required with a key. |

`ctx.connectors.email = { transport: EmailTransport, from: string }` (`createEmailContext({ transport, from })`).

Port `EmailTransport`: `send(msg & { idempotencyKey }) → { messageId }`, `findByIdempotencyKey(key)`,
`get(messageId)`, optional `list(limit)`. Both adapters refuse to deliver twice for one key:
the outbox dedupes in memory; Resend gets the `Idempotency-Key` header (provider-side dedupe for
24 h) and every send is recorded in a `SentEmailRecord` (in memory by default; back it with a table
in production) so `findByIdempotencyKey` works without a provider search API.

## Tools

| Registry name | Tool | Kind | Notes |
|---|---|---|---|
| `email.send_vendor_po` | `propose_email_send_vendor_po` | write, risk **high**, scope `propose` | input `{ to, cc?, vendor_name, po_number?, purchase_id?, subject?, body_markdown, attach_po_pdf_link? }` |
| `email.outbox_recent` | `email_outbox_recent` | read | recent sends; subject/body wrapped as untrusted text |

`send_vendor_po` hooks:

- `loadBefore` → null; `plan` → the exact message `{ from, to[], cc[], subject, text, html, po_pdf_link, context }`
  (Markdown rendered to text + escaped minimal HTML; only https links render).
- `diff` → every visible message field as `added` (html omitted, it mirrors text).
- `execute(ctx, payload, key)` sends with the key; `findByIdempotencyKey` asks the transport;
  `verify` reads the message back and checks recipients (to/cc as sets) and subject.
- `summarize` → `Email PO-123 to orders@humboldt.example (cc 1) – Humboldt Heritage Farms`.
- `moneyless: true`: an email moves no money, so the op's value is 0 and a proposal pairing a PO with
  its vendor email still gets a checkable total for `max_total_value` (a null value would make the cap
  uncheckable). `valueOf` stays an own `undefined` so the harness never hits `Object.prototype.valueOf`.
- `po_number` / `purchase_id` / the body may hold harness op references (`{{op:0.purchase_number}}`),
  resolved at execute time from the PO op that precedes the email; the approver sees the placeholder.

**No undo.** Email cannot be recalled, so there is no `compensate` hook. That is why the action is
`high` risk: `auto_approve_below` never auto-approves high-risk ops and `high_risk_requires_approval`
flags it, so a human always sees the message first. The action's `irreversible` text is what
`harness.undo` lists for it ("The email was already delivered to the vendor and cannot be unsent…").

Input validation: RFC email addresses (to, up to 10 cc, cc may not repeat to), single-line subject
and names (no header injection), https-only PDF link, non-empty body.

## Policy: recipient-domain allowlist

`emailRecipientDomainsRule` (key `email_recipient_domains`) is a connector-provided policy rule
(`definePolicyRule`). The harness `PolicyEngine` accepts custom rule implementations and rules see each
op's payload, so no extractor hook is needed. Register it with the engine (above), then configure:

```json
{ "key": "email_recipient_domains", "params": { "domains": ["humboldt.example"], "onViolation": "deny" } }
```

Subdomains of an allowed domain pass; ops on resource `emails` with unreadable recipients deny (fail closed).

```sh
bun test
bun run typecheck
```
