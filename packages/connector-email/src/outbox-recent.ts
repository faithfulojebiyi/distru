import { defineReadTool } from '@ops/harness';
import { z } from 'zod';
import type { EmailCtx } from './shared';
import { untrusted, UntrustedTextSchema } from './untrusted';

export const OutboxRecentInput = z.object({
  limit: z.number().int().min(1).max(50).default(10),
  to: z.string().trim().min(1).optional().describe('Only messages to this address or domain'),
});

export const OutboxRecentOutput = z.object({
  transport: z.string(),
  messages: z.array(
    z.object({
      message_id: z.string(),
      sent_at: z.string(),
      from: z.string(),
      to: z.array(z.string()),
      cc: z.array(z.string()),
      subject: UntrustedTextSchema.nullable(),
      body_preview: UntrustedTextSchema.nullable(),
      idempotency_key: z.string(),
    }),
  ),
});
export type OutboxRecent = z.infer<typeof OutboxRecentOutput>;

export const outboxRecentTool = defineReadTool({
  name: 'outbox_recent',
  description: 'Recently sent emails (most recent first): recipients, subject and a body preview. For checking what was sent to a vendor.',
  input: OutboxRecentInput,
  output: OutboxRecentOutput,
  run: async (ctx: EmailCtx, input): Promise<OutboxRecent> => {
    const { transport } = ctx.connectors.email;
    const all = transport.list ? await transport.list(input.to ? 200 : input.limit) : [];
    const needle = input.to?.toLowerCase();
    const matches = needle ? all.filter((m) => [...m.to, ...m.cc].some((a) => a.toLowerCase() === needle || a.toLowerCase().endsWith(`@${needle}`) || a.toLowerCase().endsWith(`.${needle}`))) : all;
    return {
      transport: transport.name,
      messages: matches.slice(0, input.limit).map((m) => ({
        message_id: m.messageId,
        sent_at: m.sentAt,
        from: m.from,
        to: m.to,
        cc: m.cc,
        subject: untrusted(m.subject, 'email.subject'),
        body_preview: untrusted(m.text, 'email.body', 300),
        idempotency_key: m.idempotencyKey,
      })),
    };
  },
});
