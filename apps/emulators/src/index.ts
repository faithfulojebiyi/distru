import { configFromEnv, createWorld, IDS } from './world';
import { COMPOSIO_USER_ID, PURCHASING } from './domain';

const config = configFromEnv();
const world = createWorld(config);
const port = Number(process.env.PORT ?? 4700);
const server = Bun.serve({ port, fetch: (request) => world.fetch(request) });
const base = `http://localhost:${server.port}`;

console.log(
  [
    `[emulators] ${base}`,
    `  composio  baseURL=${base}  apiKey=${config.composioApiKey}  userId=${COMPOSIO_USER_ID}  gmail=${IDS.gmailAccount} (${PURCHASING.email})  calendar=${IDS.calendarAccount}`,
    `            trigger GMAIL_NEW_GMAIL_MESSAGE=${IDS.gmailTrigger} → ${config.composioWebhookUrl} (poll ${config.pollMs}ms)`,
    `  slack     slackApiUrl=${base}/slack/api/  bot=${config.slackBotToken}  events → ${config.slackEventsUrl}`,
    `  google    ${base}/google (Gmail/Calendar REST, for debugging)`,
    `  resend    ${base}/resend (auth emails; any re_ key) · mailbox GET ${base}/__emu/resend/messages?to=`,
    `  control   GET ${base}/__emu/state · POST /__emu/reset · POST /__emu/simulate/vendor-reply · GET /__emu/slack/messages?channel= · POST /__emu/slack/click`,
  ].join('\n'),
);

const stop = async () => {
  await world.close();
  server.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
