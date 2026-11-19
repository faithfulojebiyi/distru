/** Historical vendor mail: seeded on (re)seed, threaded, already read, and never firing the Gmail trigger. */
import { gmailMailbox } from '@ops/emulators';
import { afterAll, describe, expect, test } from 'bun:test';
import { PURCHASING, VENDORS } from '../src/domain';
import { VENDOR_THREADS } from '../src/history';
import { createWorld } from '../src/world';

const NOW = new Date('2026-11-19T17:00:00Z');
const received: string[] = [];
const receiver = Bun.serve({
  port: 0,
  async fetch(request) {
    received.push(await request.text());
    return new Response('ok');
  },
});
const make = () => createWorld({ pollMs: 0, composioWebhookUrl: `http://127.0.0.1:${receiver.port}/api/webhooks/composio` }, { clock: () => new Date(NOW) });
const worlds: ReturnType<typeof createWorld>[] = [];
const world = () => {
  const w = make();
  worlds.push(w);
  return w;
};

afterAll(async () => {
  await Promise.all(worlds.map((w) => w.close()));
  receiver.stop(true);
});

describe('vendor mail history', () => {
  test('purchasing@ and every vendor have a few months of read, threaded mail', () => {
    const w = world();
    const purchasing = gmailMailbox(w.google, PURCHASING.email);
    const all = purchasing.messages();
    const total = VENDOR_THREADS.reduce((n, t) => n + t.messages.length, 0);
    expect(all.length).toBe(total);
    expect(all.every((m) => !m.labelIds.includes('UNREAD'))).toBe(true);
    const ages = all.map((m) => (NOW.getTime() - m.date.getTime()) / 86_400_000);
    expect(Math.max(...ages)).toBeGreaterThan(60);
    expect(Math.min(...ages)).toBeGreaterThan(1);
    // one Gmail thread per conversation, with Re: subjects after the first message
    const sec = all.filter((m) => m.subject.endsWith('Supply update – extraction line'));
    expect(sec).toHaveLength(3);
    expect(new Set(sec.map((m) => m.threadId)).size).toBe(1);
    expect(sec.filter((m) => m.subject.startsWith('Re: '))).toHaveLength(2);
    expect(new Set(all.map((m) => m.threadId)).size).toBe(VENDOR_THREADS.length);
    // each vendor sees its side of the conversations, threaded too
    for (const v of VENDORS) {
      const box = gmailMailbox(w.google, v.email).messages();
      const threads = VENDOR_THREADS.filter((t) => t.vendor === v.key);
      expect(box.length).toBe(threads.reduce((n, t) => n + t.messages.length, 0));
      expect(new Set(box.map((m) => m.threadId)).size).toBe(threads.length);
    }
  });

  test('the mix: PO confirmations, one delay notice, one price change, Sierra’s extraction-line trouble, check-ins', () => {
    const kinds = (k: string) => VENDOR_THREADS.filter((t) => t.kind === k);
    expect(kinds('po_confirmation').length).toBeGreaterThanOrEqual(8);
    expect(kinds('delay_notice')).toHaveLength(1);
    expect(kinds('price_change')).toHaveLength(1);
    expect(kinds('check_in').length).toBeGreaterThanOrEqual(2);
    const supply = kinds('supply_issue');
    expect(supply.map((t) => t.vendor)).toEqual(['SEC']);
    expect(supply[0]!.messages[0]!.text).toContain("we're having supply issues with our extraction line");
    // every vendor is in the history; PO numbers stay within the mock's seeded ones (≤ PO-520)
    expect(new Set(VENDOR_THREADS.map((t) => t.vendor)).size).toBe(6);
    const pos = VENDOR_THREADS.flatMap((t) => [t.subject, ...t.messages.map((m) => m.text)].join(' ').match(/PO-\d+/g) ?? []);
    expect(pos.length).toBeGreaterThan(0);
    expect(pos.every((p) => Number(p.slice(3)) <= 520)).toBe(true);
  });

  test('deterministic: same clock, same mailbox content', () => {
    const view = (w: ReturnType<typeof createWorld>) =>
      gmailMailbox(w.google, PURCHASING.email)
        .messages()
        .map((m) => ({ from: m.from, to: m.to, subject: m.subject, date: m.date.toISOString(), text: m.text, labels: [...m.labelIds].sort(), messageId: m.header('message-id') }));
    expect(view(world())).toEqual(view(world()));
  });

  test('history never fires GMAIL_NEW_GMAIL_MESSAGE, also after a reset', () => {
    const w = world();
    expect(w.poll()).toBe(0);
    w.reset();
    expect(w.poll()).toBe(0);
    expect(w.composio.outbox.all().length).toBe(0);
    expect((w.state().gmail as { history: { messages: number } }).history.messages).toBe(2 * VENDOR_THREADS.reduce((n, t) => n + t.messages.length, 0));
  });

  test('simulate/vendor-reply ignores the history: no PO emailed → a fresh PO-527 thread that fires once', async () => {
    const w = world();
    const sim = (await w.simulateVendorReply({ vendor: 'MPR', kind: 'confirm' })) as { poNumber: string; inReplyTo: string | null; triggersFired: number; message: { subject: string; threadId: string } };
    expect(sim.poNumber).toBe('PO-527');
    expect(sim.inReplyTo).toBeNull();
    expect(sim.triggersFired).toBe(1);
    expect(sim.message.subject).toBe('Re: Purchase order PO-527 – Mojave Pre-Roll Co.');
    const historyThreads = new Set(gmailMailbox(w.google, PURCHASING.email).messages().filter((m) => m.subject.includes('PO-51')).map((m) => m.threadId));
    expect(historyThreads.has(sim.message.threadId)).toBe(false);
  });
});
