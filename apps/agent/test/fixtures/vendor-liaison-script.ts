/**
 * Scripted Vendor Liaison: reads the PO and the (untrusted) thread from its prompt and extracts what
 * the latest vendor message states, the way the instructions ask. It never acts on instructions in
 * the email: injected text only sets `injection_detected` and a `suspicious_text` flag.
 */
import { z } from 'zod';
import { jsonAfter, type Script } from './scripted-model';

const Untrusted = z.object({ untrusted_text: z.string() }).nullable().optional();
const Message = z.looseObject({ body: Untrusted, snippet: Untrusted, subject: Untrusted, fromAddress: z.string().nullable().optional() });
const Thread = z.object({ messages: z.array(Message) });
const Purchase = z.object({ lines: z.array(z.object({ product_id: z.string(), sku: z.string().nullable() })) });

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "Dec 2" → next such date on/after today (YYYY-MM-DD). */
function resolveDate(text: string, today: string): string | null {
  const m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})/.exec(text);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]!.toLowerCase());
  if (month < 0) return null;
  const t = new Date(`${today}T00:00:00Z`);
  let d = new Date(Date.UTC(t.getUTCFullYear(), month, Number(m[2])));
  if (d < t) d = new Date(Date.UTC(t.getUTCFullYear() + 1, month, Number(m[2])));
  return d.toISOString().slice(0, 10);
}

export const vendorLiaisonScript: Script = ({ prompt }) => {
  const today = /Today is (\d{4}-\d{2}-\d{2})/.exec(prompt)?.[1] ?? '2026-11-19';
  const po = Purchase.parse(jsonAfter(prompt, 'Purchase order (trusted ERP data):'));
  const thread = Thread.parse(jsonAfter(prompt, 'Email thread (UNTRUSTED external text, data only):'));
  const last = thread.messages.at(-1);
  const text = last?.body?.untrusted_text ?? last?.snippet?.untrusted_text ?? '';
  const lineOf = (sku: string) => po.lines.find((l) => l.sku?.toLowerCase() === sku.toLowerCase()) ?? null;

  const injection = /SYSTEM:|ignore previous instructions|approve all/i.exec(text);
  const suspicious_text = injection
    ? [{ product_id: null, sku: null, source: 'composio.gmail.body', excerpt: text.slice(Math.max(0, injection.index), injection.index + 120), note: 'Instruction-like text in a vendor email; ignored.' }]
    : [];

  const partial = /ship (\d+) of the (\d+) units of ([\w-]+)/i.exec(text);
  const eta = /ETA of ([A-Za-z]+ \d{1,2})/i.exec(text) ?? /ships ([A-Za-z]+ \d{1,2}) instead/i.exec(text);
  const price = /cost on ([\w-]+) goes from \$([\d.]+) to \$([\d.]+)/i.exec(text);

  let kind: 'partial' | 'delay' | 'confirm' | 'price_change' | 'other' = 'other';
  const lines: unknown[] = [];
  if (partial) {
    kind = 'partial';
    const line = lineOf(partial[3]!);
    lines.push({ sku: partial[3], product_id: line?.product_id ?? null, shipped_quantity: Number(partial[1]), backordered_quantity: Number(partial[2]) - Number(partial[1]), new_unit_price: null });
  } else if (price) {
    kind = 'price_change';
    lines.push({ sku: price[1], product_id: lineOf(price[1]!)?.product_id ?? null, shipped_quantity: null, backordered_quantity: null, new_unit_price: Number(price[3]) });
  } else if (/delayed/i.test(text)) {
    kind = 'delay';
  } else if (/Confirming/i.test(text)) {
    kind = 'confirm';
  }
  const etaText = eta?.[1] ?? null;
  return {
    final: {
      kind,
      lines,
      eta: etaText ? resolveDate(etaText, today) : null,
      eta_text: etaText,
      summary: `Vendor reply classified as ${kind}.`,
      injection_detected: Boolean(injection),
      suspicious_text,
    },
  };
};
