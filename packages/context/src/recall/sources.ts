/**
 * Recall sources → documents.
 *
 * - **Email** (`emailDoc`): one message of the purchasing mailbox, as read through Composio Gmail
 *   (`GMAIL_FETCH_EMAILS` / the Gmail trigger; the app adapter normalizes Composio's message view into
 *   `MailMessage`). Doc id `gmail:<messageId>` whichever path saw it first, so a vendor reply indexed by
 *   the trigger and later seen by the mailbox cron is one document.
 * - **PO notes** (`purchaseNoteDocs`): a Distru purchase order's description (its notes; Ops Agent's
 *   idempotency marker stripped) plus internal / external notes where the API has them, handed over
 *   by the context sync (`DistruSyncOptions.onFreeText`). The structured context layer deliberately
 *   never stores free text; recall keeps it, as untrusted text, for retrieval only.
 *
 * Vendors are resolved from the synced Distru companies (`vendorResolver`): exact address, then domain.
 */
import { z } from 'zod';
import type { CompanyRow } from '../model';
import type { ContextStore } from '../store';
import { poNumbersIn } from './chunk';
import type { RecallDoc, RecallSource } from './model';

export const MailMessageSchema = z.object({
  messageId: z.string().min(1),
  threadId: z.string().nullable(),
  /** ISO-8601. */
  date: z.string(),
  /** The raw From header (display name + address). Untrusted. */
  from: z.string().nullable(),
  fromAddress: z.string().nullable(),
  to: z.array(z.string()),
  subject: z.string().nullable(),
  body: z.string(),
  labelIds: z.array(z.string()),
});
export type MailMessage = z.infer<typeof MailMessageSchema>;

export interface VendorRef {
  id: string;
  name: string;
}

export type VendorResolver = (addresses: readonly (string | null | undefined)[]) => VendorRef | null;

const domainOf = (address: string) => address.split('@')[1]?.toLowerCase() ?? '';

/** Vendor by exact email, else by email domain, among the synced vendor companies. */
export function vendorResolver(companies: readonly Pick<CompanyRow, 'sourceId' | 'name' | 'email' | 'relationship' | 'deletedAt'>[], opts: { ownDomains?: readonly string[] } = {}): VendorResolver {
  const own = new Set((opts.ownDomains ?? []).map((d) => d.toLowerCase()));
  const vendors = companies.filter((c) => c.relationship === 'vendor' && !c.deletedAt && c.email);
  const byEmail = new Map(vendors.map((c) => [c.email!.toLowerCase(), c] as const));
  const byDomain = new Map<string, (typeof vendors)[number]>();
  for (const c of vendors) {
    const d = domainOf(c.email!);
    if (d && !own.has(d) && !byDomain.has(d)) byDomain.set(d, c);
  }
  return (addresses) => {
    const list = addresses.filter((a): a is string => !!a).map((a) => a.toLowerCase());
    const hit = list.map((a) => byEmail.get(a)).find(Boolean) ?? list.map((a) => byDomain.get(domainOf(a))).find(Boolean);
    return hit ? { id: hit.sourceId, name: hit.name } : null;
  };
}

/** `vendorResolver` over the context store's synced vendors. */
export async function vendorResolverFromStore(store: ContextStore, opts: { ownDomains?: readonly string[] } = {}): Promise<VendorResolver> {
  return vendorResolver(await store.list('company'), opts);
}

export function emailDoc(m: MailMessage, opts: { vendorOf?: VendorResolver; source?: Extract<RecallSource, 'email' | 'vendor_reply'> } = {}): RecallDoc {
  const msg = MailMessageSchema.parse(m);
  const vendor = opts.vendorOf?.([msg.fromAddress, ...msg.to]) ?? null;
  const subject = msg.subject?.trim() || '(no subject)';
  return {
    id: `gmail:${msg.messageId}`,
    source: opts.source ?? 'email',
    sourceId: msg.messageId,
    title: subject,
    text: msg.body,
    author: msg.from,
    vendorId: vendor?.id ?? null,
    vendorName: vendor?.name ?? null,
    poNumbers: poNumbersIn(subject, msg.body),
    threadId: msg.threadId,
    messageId: msg.messageId,
    date: msg.date,
    ref: `gmail:thread/${msg.threadId ?? msg.messageId}#${msg.messageId}`,
  };
}

/** Distru purchase as the REST API returns it (only what recall needs; unknown keys ignored). */
export const DistruPurchaseNotesIn = z.looseObject({
  id: z.string(),
  purchase_number: z.string().nullish(),
  company: z.looseObject({ id: z.string(), name: z.string().nullish() }).nullish(),
  order_datetime: z.string().nullish(),
  updated_datetime: z.string().nullish(),
  description: z.string().nullish(),
  internal_notes: z.string().nullish(),
  external_notes: z.string().nullish(),
});

/** Ops Agent's idempotency marker in PO descriptions (connector-distru `stampDescription`). */
const IDEM_MARKER = /\n?\[ops-agent:idem=[A-Za-z0-9._:-]+\]/g;

const STOPWORDS = new Set('a an and are as at be by for from in is it of on or our the this to with'.split(' '));

/**
 * True when a note says nothing beyond the vendor's name (`Restock from Sierra Extracts Co.`): fewer
 * than 4 words left once the vendor name, PO numbers and stopwords are removed. Such boilerplate would
 * only match queries on the vendor's name and crowd out real history.
 */
export function isBoilerplateNote(text: string, vendorName: string | null): boolean {
  const vendorWords = new Set((vendorName ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const words = (text.replace(/\bPO-\d+\b/g, '').toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !STOPWORDS.has(w) && !vendorWords.has(w));
  return words.length < 4;
}

/**
 * One document per purchase (also when its notes are empty or boilerplate: re-ingesting an emptied
 * note removes its old chunks). `vendorNames` maps Distru company ids to names (from the synced companies).
 */
export function purchaseNoteDocs(raws: readonly unknown[], opts: { vendorNames?: ReadonlyMap<string, string>; now: string }): RecallDoc[] {
  return raws.flatMap((raw) => {
    const parsed = DistruPurchaseNotesIn.safeParse(raw);
    if (!parsed.success) return [];
    const p = parsed.data;
    const number = p.purchase_number ?? null;
    const vendorId = p.company?.id ?? null;
    const vendorName = (vendorId ? opts.vendorNames?.get(vendorId) : null) ?? p.company?.name ?? null;
    const keep = (s: string | null | undefined) => {
      const t = (s ?? '').replace(IDEM_MARKER, '').trim();
      return t && !isBoilerplateNote(t, vendorName) ? t : '';
    };
    const description = keep(p.description);
    const internal = keep(p.internal_notes);
    const external = keep(p.external_notes);
    const text = [description ? `PO notes: ${description}` : '', internal ? `Internal notes: ${internal}` : '', external ? `External notes: ${external}` : ''].filter(Boolean).join('\n\n');
    return [
      {
        id: `distru_po:${p.id}`,
        source: 'po_note' as const,
        sourceId: p.id,
        title: `${number ?? 'Purchase order'} notes${vendorName ? ` (${vendorName})` : ''}`,
        text,
        author: null,
        vendorId,
        vendorName,
        poNumbers: [...new Set([...(number ? [number] : []), ...poNumbersIn(text)])],
        threadId: null,
        messageId: null,
        date: p.updated_datetime ?? p.order_datetime ?? opts.now,
        ref: `distru:purchase/${p.id}`,
      },
    ];
  });
}
