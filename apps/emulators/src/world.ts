/**
 * The emulator world: Google (Gmail + Calendar), Composio (connected to Google and Slack) and
 * Slack, seeded for Golden Coast Distribution, behind one fetch handler with `/__emu` control
 * endpoints. `src/index.ts` serves it with Bun; tests use `createWorld` in-process.
 */
import {
  App,
  composio,
  composioProject,
  connectComposioBackends,
  createEmulator,
  gmailMailbox,
  google,
  grantGoogleAccess,
  pollGmailTriggers,
  seedComposio,
  seedGoogle,
  seedSlack,
  slack,
  slackWorkspace,
  type Emulator,
  type EmulatorOptions,
  type GmailMessage,
} from '@ops/emulators';
import { z } from 'zod';
import { COMPANY, COMPOSIO_USER_ID, findVendor, PURCHASING, SLACK_CHANNELS, SLACK_USERS, VENDORS } from './domain';
import { composeReply, VendorReplyRequestSchema, type VendorReplyRequest } from './replies';

export const WorldConfigSchema = z.object({
  /** Composio project API key the SDK must send (`x-api-key`). Real keys start with `ak_`. */
  composioApiKey: z.string().min(1).default('ak_emulator_goldencoast_local0001'),
  /** Where the project's webhook subscription delivers trigger events. */
  composioWebhookUrl: z.string().url().default('http://localhost:4111/api/webhooks/composio'),
  composioWebhookSecret: z.string().min(1).default('whsec_emulator_goldencoast_local'),
  slackBotToken: z.string().min(1).default('xoxb-emulator-goldencoast-ops-agent'),
  slackSigningSecret: z.string().min(1).default('emulator-slack-signing-secret'),
  /** Events API request URL of the Ops Agent Slack app. */
  slackEventsUrl: z.string().url().default('http://localhost:4111/api/webhooks/slack'),
  /** Interactivity request URL (button clicks); defaults to the events URL. */
  slackInteractivityUrl: z.string().url().optional(),
  /** How often the Gmail trigger polls the purchasing mailbox (ms); 0 disables the loop. */
  pollMs: z.number().int().nonnegative().default(1000),
});
export type WorldConfig = z.infer<typeof WorldConfigSchema>;

/** Reads the config from env (see README for the variables). */
export function configFromEnv(env: Record<string, string | undefined> = process.env): WorldConfig {
  const pick = (k: string) => (env[k] ? env[k] : undefined);
  return WorldConfigSchema.parse({
    composioApiKey: pick('COMPOSIO_EMULATOR_API_KEY'),
    composioWebhookUrl: pick('COMPOSIO_WEBHOOK_URL'),
    composioWebhookSecret: pick('COMPOSIO_WEBHOOK_SECRET'),
    slackBotToken: pick('SLACK_EMULATOR_BOT_TOKEN'),
    slackSigningSecret: pick('SLACK_SIGNING_SECRET'),
    slackEventsUrl: pick('SLACK_EVENTS_URL'),
    slackInteractivityUrl: pick('SLACK_INTERACTIVITY_URL'),
    pollMs: pick('EMU_POLL_MS') === undefined ? undefined : Number(env.EMU_POLL_MS),
  });
}

/** Fixed ids so the agent's env can name them (COMPOSIO_GMAIL_ACCOUNT_ID etc.). */
export const IDS = {
  gmailAuthConfig: 'ac_goldencoast_gmail',
  calendarAuthConfig: 'ac_goldencoast_gcal',
  gmailAccount: 'ca_goldencoast_gmail',
  calendarAccount: 'ca_goldencoast_gcal',
  gmailTrigger: 'ti_goldencoast_gmail_new_message',
  slackApp: 'A0OPSAGENT1',
} as const;

export const SLACK_APP = {
  name: 'Ops Agent',
  app_id: IDS.slackApp,
  client_id: '7000000000001.7000000000002',
  client_secret: 'emulator-slack-client-secret',
} as const;

const SlackClickSchema = z.object({
  user: z.string().min(1).describe('Member handle, email or id, e.g. adam or approver@demo.dev'),
  channel: z.string().min(1).describe('#ops-approvals, ops-approvals or a channel id'),
  ts: z.string().min(1).optional().describe("The app message's ts; defaults to the latest app message with buttons"),
  actionId: z.string().min(1),
  value: z.string().optional(),
  blockId: z.string().optional(),
});

/** A Gmail message as the control endpoints show it. */
function summary(m: GmailMessage) {
  return { id: m.id, threadId: m.threadId, from: m.from, to: m.to, subject: m.subject, date: m.date.toISOString(), labelIds: m.labelIds, text: m.text ?? '' };
}

export interface World {
  readonly config: WorldConfig;
  readonly google: Emulator;
  readonly composio: Emulator;
  readonly slack: Emulator;
  /** The whole HTTP surface: Composio at `/`, Slack at `/slack`, Google at `/google`, control at `/__emu`. */
  fetch(request: Request): Promise<Response>;
  /** Clears every emulator and seeds the domain again. */
  reset(): void;
  /** One Gmail-trigger poll (the server runs it every `pollMs`). Returns how many fired. */
  poll(): number;
  simulateVendorReply(request: VendorReplyRequest): Promise<Record<string, unknown>>;
  state(): Record<string, unknown>;
  close(): Promise<void>;
}

export function createWorld(input: Partial<WorldConfig> = {}, options: Pick<EmulatorOptions, 'fetch' | 'clock' | 'timer' | 'wallClock'> = {}): World {
  const config = WorldConfigSchema.parse(input);
  const gmail = createEmulator(google, { ...options, baseUrl: 'https://gmail.googleapis.com' });
  const project = createEmulator(composio, { ...options, baseUrl: 'https://backend.composio.dev' });
  const workspace = createEmulator(slack, { ...options, baseUrl: 'https://slack.com' });
  const vendorTokens = new Map<string, string>();

  connectComposioBackends(project, { google: gmail, slack: workspace });

  function seed(): void {
    seedGoogle(gmail.store, { users: [{ ...PURCHASING, hd: COMPANY.domain }, ...VENDORS.map((v) => ({ email: v.email, name: v.contact }))] });
    vendorTokens.clear();
    for (const v of VENDORS) vendorTokens.set(v.email, grantGoogleAccess(gmail, v.email));

    seedComposio(project.store, {
      apiKeys: [config.composioApiKey],
      authConfigs: [
        { id: IDS.gmailAuthConfig, toolkit: 'gmail', name: 'Golden Coast Gmail' },
        { id: IDS.calendarAuthConfig, toolkit: 'googlecalendar', name: 'Golden Coast Calendar' },
      ],
      connectedAccounts: [
        { id: IDS.gmailAccount, userId: COMPOSIO_USER_ID, toolkit: 'gmail', authConfig: IDS.gmailAuthConfig, credentials: { access_token: grantGoogleAccess(gmail, PURCHASING.email) }, label: PURCHASING.email },
        { id: IDS.calendarAccount, userId: COMPOSIO_USER_ID, toolkit: 'googlecalendar', authConfig: IDS.calendarAuthConfig, credentials: { access_token: grantGoogleAccess(gmail, PURCHASING.email) }, label: PURCHASING.email },
      ],
      triggers: [{ id: IDS.gmailTrigger, trigger: 'GMAIL_NEW_GMAIL_MESSAGE', connectedAccount: IDS.gmailAccount, config: { labelIds: 'INBOX', interval: 1 } }],
      webhook: { url: config.composioWebhookUrl, secret: config.composioWebhookSecret },
    });

    seedSlack(workspace.store, {
      team: { name: COMPANY.name, domain: 'goldencoast' },
      users: SLACK_USERS.map((u) => ({ ...u })),
      channels: SLACK_CHANNELS.map((name) => ({ name, members: SLACK_USERS.map((u) => u.name) })),
      apps: [
        {
          ...SLACK_APP,
          signing_secret: config.slackSigningSecret,
          bot_scopes: ['chat:write', 'channels:read', 'channels:history', 'users:read', 'users:read.email'],
          events: { url: config.slackEventsUrl, bot_events: ['app_mention', 'message.channels'] },
          interactivity_url: config.slackInteractivityUrl ?? config.slackEventsUrl,
        },
      ],
      installations: [{ app: SLACK_APP.app_id, installer: 'adam', bot_token: config.slackBotToken, channels: [...SLACK_CHANNELS] }],
    });

    pollGmailTriggers(project, gmail); // baseline: messages already there never fire
  }

  seed();

  const poll = () => pollGmailTriggers(project, gmail);
  const timer = config.pollMs > 0 ? setInterval(poll, config.pollMs) : undefined;
  timer?.unref?.();

  async function simulateVendorReply(raw: VendorReplyRequest): Promise<Record<string, unknown>> {
    const req = VendorReplyRequestSchema.parse(raw);
    const vendor = findVendor(req.vendor);
    if (!vendor) throw new HttpProblem(404, `Unknown vendor '${req.vendor}'. Known: ${VENDORS.map((v) => `${v.key} (${v.email})`).join(', ')}`);

    // The PO email the vendor got from purchasing (sent through Composio's GMAIL_SEND_EMAIL), if any.
    const fromBuyer = gmailMailbox(gmail, vendor.email)
      .inbox()
      .filter((m) => m.from.toLowerCase().includes(PURCHASING.email));
    const original = req.poNumber ? fromBuyer.find((m) => `${m.subject}\n${m.text ?? ''}`.includes(req.poNumber ?? '')) : fromBuyer[0];
    const poNumber = req.poNumber ?? /PO-\d+/.exec(original?.subject ?? '')?.[0] ?? 'PO-527';
    const reply = composeReply(vendor, poNumber, req, original?.subject);
    const messageId = original?.header('message-id');
    const headers = [
      `From: "${vendor.contact} (${vendor.name})" <${vendor.email}>`,
      `To: ${PURCHASING.email}`,
      `Subject: ${reply.subject}`,
      ...(messageId ? [`In-Reply-To: ${messageId}`, `References: ${original?.header('references') ? `${original.header('references')} ` : ''}${messageId}`] : []),
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
    ];
    const rawMessage = Buffer.from(`${headers.join('\r\n')}\r\n\r\n${reply.text}`).toString('base64url');

    // Sent from the vendor's own Gmail account through the Gmail API, so it is delivered to the
    // purchasing inbox (threaded under the PO email) exactly as a real reply would be.
    const sent = await gmail.fetch(
      new Request('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { authorization: `Bearer ${vendorTokens.get(vendor.email) ?? ''}`, 'content-type': 'application/json' },
        body: JSON.stringify({ raw: rawMessage, ...(original ? { threadId: original.threadId } : {}) }),
      }),
    );
    if (!sent.ok) throw new HttpProblem(502, `Gmail send failed: ${sent.status} ${await sent.text()}`);

    const received = gmailMailbox(gmail, PURCHASING.email).inbox()[0];
    const fired = poll();
    return { vendor: { key: vendor.key, name: vendor.name, email: vendor.email }, kind: req.kind, poNumber, inReplyTo: original?.id ?? null, message: received ? summary(received) : null, triggersFired: fired };
  }

  function state(): Record<string, unknown> {
    const proj = composioProject(project);
    const ws = slackWorkspace(workspace);
    return {
      composio: {
        accounts: proj.accounts(),
        executions: proj.executions().slice(-20),
        webhooks: project.outbox.all().slice(-20).map((m) => ({ id: m.id, topic: m.topic, body: m.body })),
        deliveries: project.webhooks?.attempts().slice(-20) ?? [],
      },
      gmail: {
        purchasing: { inbox: gmailMailbox(gmail, PURCHASING.email).inbox().slice(0, 20).map(summary), sent: gmailMailbox(gmail, PURCHASING.email).sent().slice(0, 20).map(summary) },
        vendors: Object.fromEntries(VENDORS.map((v) => [v.key, { email: v.email, inbox: gmailMailbox(gmail, v.email).inbox().length, sent: gmailMailbox(gmail, v.email).sent().length }])),
      },
      slack: {
        channels: Object.fromEntries(SLACK_CHANNELS.map((c) => [c, ws.messages(c).length])),
        deliveries: workspace.webhooks?.attempts().slice(-20) ?? [],
      },
    };
  }

  const control = new App();
  control.onError((error, c) => (error instanceof HttpProblem ? c.json({ error: error.message }, error.status) : c.json({ error: error instanceof Error ? error.message : String(error) }, 400)));
  control.get('/__emu/health', (c) => c.json({ ok: true }));
  control.get('/__emu/state', (c) => c.json(state()));
  control.post('/__emu/reset', (c) => {
    reset();
    return c.json({ ok: true });
  });
  control.post('/__emu/poll', (c) => c.json({ fired: poll() }));
  control.post('/__emu/simulate/vendor-reply', async (c) => c.json(await simulateVendorReply(VendorReplyRequestSchema.parse(await c.req.json()))));
  control.get('/__emu/slack/messages', (c) => {
    const channel = c.req.query('channel') ?? 'ops-approvals';
    return c.json({ channel, messages: slackWorkspace(workspace).messages(channel) });
  });
  control.post('/__emu/slack/click', async (c) => {
    const click = SlackClickSchema.parse(await c.req.json());
    const ws = slackWorkspace(workspace);
    const ts = click.ts ?? ws.messages(click.channel).filter((m) => m.botId !== null && m.blocks !== null).at(-1)?.ts;
    if (!ts) throw new HttpProblem(404, `No app message with blocks in ${click.channel}`);
    ws.click(click.user, click.channel, ts, { actionId: click.actionId, ...(click.value !== undefined ? { value: click.value } : {}), ...(click.blockId !== undefined ? { blockId: click.blockId } : {}) });
    return c.json({ ok: true, ts });
  });

  function reset(): void {
    gmail.reset();
    project.reset();
    workspace.reset();
    seed();
  }

  const forward = (target: Emulator, prefix: string, origin: string) => (request: Request) => {
    const url = new URL(request.url);
    return target.fetch(new Request(`${origin}${url.pathname.slice(prefix.length) || '/'}${url.search}`, request));
  };
  const toSlack = forward(workspace, '/slack', 'https://slack.com');
  const toGoogle = forward(gmail, '/google', 'https://gmail.googleapis.com');

  return {
    config,
    google: gmail,
    composio: project,
    slack: workspace,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.startsWith('/__emu/')) return control.fetch(request);
      if (path === '/slack' || path.startsWith('/slack/')) return toSlack(request);
      if (path === '/google' || path.startsWith('/google/')) return toGoogle(request);
      return project.fetch(request);
    },
    reset,
    poll,
    simulateVendorReply,
    state,
    async close() {
      if (timer) clearInterval(timer);
      await Promise.all([gmail.close(), project.close(), workspace.close()]);
    },
  };
}

class HttpProblem extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
