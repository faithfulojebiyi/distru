/**
 * A few months of mail between purchasing@ and the six vendors, matching apps/distru-mock's purchase
 * history (PO numbers, SKUs, the Wedding Cake lab failure, the Golden State chocolate PO still open):
 * PO confirmations, one delay notice, one price-change notice, Sierra Extracts' extraction-line trouble
 * and a couple of friendly check-ins.
 *
 * Seeded on every (re)seed, before the Gmail trigger's baseline poll, so none of it ever fires
 * GMAIL_NEW_GMAIL_MESSAGE. Every message is already read (no UNREAD label). Both copies of a message
 * (sender's SENT, recipient's INBOX) carry the same Message-ID, and replies carry In-Reply-To /
 * References, so each mailbox threads them the way Gmail does. Dates are relative to the emulator
 * clock; content is fixed.
 */
import { gmailMailbox, type Emulator, type IncomingMail } from '@ops/emulators';
import { COMPANY, PURCHASING, VENDORS, type Vendor } from './domain';

const BUYER = { name: 'Sam Rivera', title: 'Purchasing Manager' };
const SIGN_BUYER = `\n\nThanks,\n${BUYER.name}\n${BUYER.title}, ${COMPANY.name}\n${PURCHASING.email}`;
const signVendor = (v: Vendor) => `\n\nBest,\n${v.contact}\n${v.name}`;

export interface HistoryMessage {
  /** `buyer` = purchasing@ → vendor; `vendor` = vendor → purchasing@ */
  from: 'buyer' | 'vendor';
  /** days before now (fractional ok) */
  daysAgo: number;
  text: string;
}

export interface HistoryThread {
  key: string;
  vendor: Vendor['key'];
  subject: string;
  messages: HistoryMessage[];
  /** what the thread is, for /__emu/state and tests */
  kind: 'po_confirmation' | 'delay_notice' | 'price_change' | 'supply_issue' | 'check_in' | 'quality';
}

const v = (key: Vendor['key']) => VENDORS.find((x) => x.key === key)!;

/** Purchase orders as the vendor sees them in the PO email (numbers / dates match distru-mock's seed). */
const poEmail = (po: string, vendorKey: Vendor['key'], lines: string, eta: string) =>
  `Hi ${v(vendorKey).contact.split(' ')[0]},\n\nPlease find purchase order ${po} below.\n\n${lines}\n\nShip to: Oakland Warehouse, 2200 Adeline St, Oakland, CA 94607 (C11-0000347-LIC)\nRequested delivery: ${eta}\nTerms: Net 30. Please confirm receipt and ship date.${SIGN_BUYER}`;

const confirm = (vendorKey: Vendor['key'], po: string, extra = '') =>
  `Hi Sam,\n\nConfirming ${po} — all lines are in stock and scheduled to ship on the requested date. Manifest and invoice will follow with the delivery.${extra}${signVendor(v(vendorKey))}`;

export const VENDOR_THREADS: readonly HistoryThread[] = [
  // ── Humboldt Heritage Farms ──────────────────────────────────────────────────────────────────
  {
    key: 'hhf-po-502',
    vendor: 'HHF',
    kind: 'po_confirmation',
    subject: 'Purchase order PO-502 – Humboldt Heritage Farms',
    messages: [
      { from: 'buyer', daysAgo: 72, text: poEmail('PO-502', 'HHF', '- FLW-BD-35 Blue Dream 3.5g\n- FLW-OGK-35 OG Kush 3.5g\n- FLW-GSC-35 Girl Scout Cookies 3.5g\n- FLW-GL-35 Gelato 3.5g\n- PRE-HYB-5PK House Hybrid Mini Pre-Rolls 5-Pack', 'one week out') },
      { from: 'vendor', daysAgo: 71.8, text: confirm('HHF', 'PO-502') },
    ],
  },
  {
    key: 'hhf-po-503',
    vendor: 'HHF',
    kind: 'po_confirmation',
    subject: 'Purchase order PO-503 – Humboldt Heritage Farms',
    messages: [
      { from: 'buyer', daysAgo: 27, text: poEmail('PO-503', 'HHF', '- FLW-BD-35 Blue Dream 3.5g\n- FLW-OGK-35 OG Kush 3.5g\n- FLW-GSC-35 Girl Scout Cookies 3.5g\n- FLW-GL-35 Gelato 3.5g\n- PRE-HYB-5PK House Hybrid Mini Pre-Rolls 5-Pack\n- PRE-IND-10PK Indica Dogwalkers 10-Pack', 'one week out') },
      { from: 'vendor', daysAgo: 26.9, text: confirm('HHF', 'PO-503', '\n\nNote the new-harvest pricing (about +4%) applies from this order, as mentioned on our call.') },
      { from: 'buyer', daysAgo: 26.7, text: `Got it, thanks Dana — the new pricing is fine for this run.${SIGN_BUYER}` },
    ],
  },
  {
    key: 'hhf-checkin',
    vendor: 'HHF',
    kind: 'check_in',
    subject: 'Harvest update from Humboldt',
    messages: [
      { from: 'vendor', daysAgo: 12, text: `Hi Sam,\n\nQuick harvest update: the fall outdoor run came in strong, especially Blue Dream — big, dense colas and testing in the mid-20s. We'll have plenty of eighths through January if you want to plan a larger order before the holidays.\n\nHope the team is doing well!${signVendor(v('HHF'))}` },
      { from: 'buyer', daysAgo: 11.8, text: `Great to hear, Dana. Blue Dream has been flying off the shelf for us, so that's good timing. We'll likely bump the next order — I'll send it over once our restock run lands.${SIGN_BUYER}` },
    ],
  },
  // ── Emerald Triangle Growers ─────────────────────────────────────────────────────────────────
  {
    key: 'etg-po-505',
    vendor: 'ETG',
    kind: 'po_confirmation',
    subject: 'Purchase order PO-505 – Emerald Triangle Growers',
    messages: [
      { from: 'buyer', daysAgo: 76, text: poEmail('PO-505', 'ETG', '- FLW-SD-35 Sour Diesel 3.5g\n- FLW-GG4-35 Gorilla Glue #4 3.5g\n- FLW-WC-35 Wedding Cake 3.5g\n- FLW-ZK-35 Zkittlez 3.5g\n- FLW-PE-14 Purple Punch 14g', 'ten days out') },
      { from: 'vendor', daysAgo: 75.7, text: confirm('ETG', 'PO-505') },
    ],
  },
  {
    key: 'etg-po-506',
    vendor: 'ETG',
    kind: 'po_confirmation',
    subject: 'Purchase order PO-506 – Emerald Triangle Growers',
    messages: [
      { from: 'buyer', daysAgo: 31, text: poEmail('PO-506', 'ETG', '- FLW-SD-35 Sour Diesel 3.5g\n- FLW-GG4-35 Gorilla Glue #4 3.5g\n- FLW-WC-35 Wedding Cake 3.5g\n- FLW-ZK-35 Zkittlez 3.5g\n- FLW-PE-14 Purple Punch 14g', 'ten days out') },
      { from: 'vendor', daysAgo: 30.8, text: confirm('ETG', 'PO-506') },
    ],
  },
  {
    key: 'etg-lab-failure',
    vendor: 'ETG',
    kind: 'quality',
    subject: 'Wedding Cake 3.5g – latest batch failed pesticide panel',
    messages: [
      { from: 'buyer', daysAgo: 16, text: `Hi Luis,\n\nThe COA for the newest Wedding Cake 3.5g batch (FLW-WC-35, from PO-506) came back FAILED on pesticides — myclobutanil at 0.92 µg/g against the 0.10 action level. We've put every package from that batch on hold in Metrc and won't be selling it.\n\nCan you tell us what happened and how you want to handle the return / credit? We'll hold off on new Wedding Cake orders until we see a clean retest.${SIGN_BUYER}` },
      { from: 'vendor', daysAgo: 15.6, text: `Hi Sam,\n\nThanks for flagging it so fast, and sorry about this. We traced it to a neighbouring grow's spray drift on one of our greenhouse blocks. We're pulling that lot, issuing a credit for the full batch, and sending samples from the next harvest to SC Labs this week. I'll forward the retest COA as soon as we have it — probably two to three weeks.${signVendor(v('ETG'))}` },
      { from: 'buyer', daysAgo: 15.4, text: `Appreciate it, Luis. Please send the credit memo to this address and the retest COA when you have it. Until then we're keeping ETG orders on hold.${SIGN_BUYER}` },
    ],
  },
  // ── Sierra Extracts Co. ──────────────────────────────────────────────────────────────────────
  {
    key: 'sec-po-508',
    vendor: 'SEC',
    kind: 'po_confirmation',
    subject: 'Purchase order PO-508 – Sierra Extracts Co.',
    messages: [
      { from: 'buyer', daysAgo: 81, text: poEmail('PO-508', 'SEC', '- VAP-BD-1G Blue Dream Live Resin Cart 1g\n- VAP-SD-LR Sour Diesel Live Rosin Cart 0.5g\n- VAP-NL-1G Northern Lights Cart 1g\n- VAP-GDP-AIO GDP Disposable 1g\n- CON-LR-BD Blue Dream Live Resin 1g\n- CON-SHT-GG Gorilla Glue Shatter 1g\n- CON-BAD-WC Wedding Cake Badder 1g', 'two weeks out') },
      { from: 'vendor', daysAgo: 80.8, text: confirm('SEC', 'PO-508') },
    ],
  },
  {
    key: 'sec-po-509',
    vendor: 'SEC',
    kind: 'po_confirmation',
    subject: 'Purchase order PO-509 – Sierra Extracts Co.',
    messages: [
      { from: 'buyer', daysAgo: 36, text: poEmail('PO-509', 'SEC', '- VAP-BD-1G Blue Dream Live Resin Cart 1g\n- VAP-SD-LR Sour Diesel Live Rosin Cart 0.5g\n- VAP-NL-1G Northern Lights Cart 1g\n- VAP-GDP-AIO GDP Disposable 1g\n- CON-LR-BD Blue Dream Live Resin 1g\n- CON-RSN-GL Gelato Live Rosin 1g\n- CON-DIA-SD Sour Diesel Diamonds 1g', 'two weeks out') },
      { from: 'vendor', daysAgo: 35.7, text: confirm('SEC', 'PO-509', '\n\nHeads up that our input costs went up this quarter, so this order is billed at the new rates (roughly 8% higher). Happy to walk through it if useful.') },
    ],
  },
  {
    key: 'sec-supply-issue',
    vendor: 'SEC',
    kind: 'supply_issue',
    subject: 'Supply update – extraction line',
    messages: [
      { from: 'vendor', daysAgo: 9, text: `Hi Sam,\n\nWanted to give you a heads up: we're having supply issues with our extraction line. One of our hydrocarbon closed-loop extractors failed its pressure inspection and is down while we wait on a replacement vessel, so we're running at about half capacity.\n\nWhat that means for you through mid-December:\n- Live resin carts (VAP-BD-1G, VAP-NL-1G) and live resin sauce (CON-LR-BD): plan on ~3 weeks lead time instead of our usual 2.\n- Rosin and shatter are unaffected.\n- We may have to ship larger orders in two drops.\n\nIf you can get POs to us a bit earlier than usual, that helps us slot them. Sorry for the hassle — I'll update you as soon as the new vessel is in.${signVendor(v('SEC'))}` },
      { from: 'buyer', daysAgo: 8.7, text: `Thanks for the heads up, Priya. We'll plan on 21 days for the live resin SKUs until you tell us otherwise, and we're fine with split deliveries. Blue Dream carts are our biggest mover, so please prioritise those if you have to choose.${SIGN_BUYER}` },
      { from: 'vendor', daysAgo: 8.5, text: `Will do — Blue Dream carts first. Thanks for being flexible.${signVendor(v('SEC'))}` },
    ],
  },
  // ── Golden State Edibles ─────────────────────────────────────────────────────────────────────
  {
    key: 'gse-po-512',
    vendor: 'GSE',
    kind: 'po_confirmation',
    subject: 'Purchase order PO-512 – Golden State Edibles',
    messages: [
      { from: 'buyer', daysAgo: 44, text: poEmail('PO-512', 'GSE', '- EDB-GUM-WM Watermelon Gummies 100mg\n- EDB-GUM-SB Sour Blue Raspberry Gummies 100mg\n- EDB-CHO-DK Dark Chocolate Bar 100mg\n- EDB-CHO-MS Milk Chocolate Sea Salt 100mg\n- EDB-MNT-PP Peppermint Mints 100mg\n- EDB-BEV-LEM Sparkling Lemonade 10mg\n- EDB-GUM-SLP Sleep Gummies THC+CBN 100mg\n- EDB-CKE-SNK Snickerdoodle Cookie 50mg', 'three weeks out') },
      { from: 'vendor', daysAgo: 43.7, text: confirm('GSE', 'PO-512') },
    ],
  },
  {
    key: 'gse-po-519-delay',
    vendor: 'GSE',
    kind: 'delay_notice',
    subject: 'Purchase order PO-519 – Golden State Edibles',
    messages: [
      { from: 'buyer', daysAgo: 5, text: poEmail('PO-519', 'GSE', '- EDB-CHO-DK Dark Chocolate Bar 100mg × 48', 'as soon as possible') },
      { from: 'vendor', daysAgo: 3, text: `Hi Sam,\n\nBad news on PO-519: our cacao supplier slipped again, so the 48 Dark Chocolate Bars won't make this week's truck. New ship date is Dec 2. Gummies and mints are unaffected if you want to add anything to that delivery.\n\nSorry for the delay — I know the dark chocolate is moving fast for you.${signVendor(v('GSE'))}` },
      { from: 'buyer', daysAgo: 2.8, text: `Thanks for letting us know, Marcus. Dec 2 works, but please confirm by Friday that it's locked in — we're already short on the dark chocolate bars.${SIGN_BUYER}` },
    ],
  },
  // ── Coastal Cloud Vapes ──────────────────────────────────────────────────────────────────────
  {
    key: 'ccv-price-change',
    vendor: 'CCV',
    kind: 'price_change',
    subject: 'Price update effective with your next PO',
    messages: [
      { from: 'vendor', daysAgo: 45, text: `Hi Sam,\n\nGiving our wholesale partners a few weeks' notice: due to new tariffs on cartridge hardware and higher lab-testing fees, our wholesale prices go up about 7% effective with your next purchase order. For example, Pineapple Express Cart 1g (VAP-PE-1G) moves from $15.00 to $16.05 per unit. Batteries and AIO devices change by the same percentage.\n\nThe updated price sheet is attached to our portal. Let me know if you have any questions.${signVendor(v('CCV'))}` },
      { from: 'buyer', daysAgo: 44.6, text: `Thanks for the notice, Jenna. Understood — please apply the new pricing to our next PO. We'll keep an eye on how it affects sell-through.${SIGN_BUYER}` },
    ],
  },
  {
    key: 'ccv-po-515',
    vendor: 'CCV',
    kind: 'po_confirmation',
    subject: 'Purchase order PO-515 – Coastal Cloud Vapes',
    messages: [
      { from: 'buyer', daysAgo: 38, text: poEmail('PO-515', 'CCV', '- VAP-PE-1G Pineapple Express Cart 1g\n- VAP-GSC-05 GSC Cart 0.5g\n- VAP-MAN-AIO Mango Haze All-in-One 0.5g\n- VAP-WM-1G Watermelon Distillate Cart 1g\n- VAP-CBD-11 1:1 CBD Calm Cart 0.5g\n- ACC-BAT-BLK 510 Thread Battery - Black\n- ACC-BAT-SLV 510 Thread Battery - Silver', 'two weeks out') },
      { from: 'vendor', daysAgo: 37.8, text: confirm('CCV', 'PO-515', '\n\nBilled at the updated price sheet as discussed.') },
    ],
  },
  // ── Mojave Pre-Roll Co. ──────────────────────────────────────────────────────────────────────
  {
    key: 'mpr-po-517',
    vendor: 'MPR',
    kind: 'po_confirmation',
    subject: 'Purchase order PO-517 – Mojave Pre-Roll Co.',
    messages: [
      { from: 'buyer', daysAgo: 77, text: poEmail('PO-517', 'MPR', '- PRE-BD-1G Blue Dream Pre-Roll 1g\n- PRE-OGK-1G OG Kush Pre-Roll 1g\n- PRE-SD-5PK Sour Diesel Mini Pre-Rolls 5-Pack\n- PRE-INF-1G Gelato Infused Pre-Roll 1g\n- PRE-JH-1G Jack Herer Pre-Roll 1g\n- PRE-GDP-1G Granddaddy Purple Pre-Roll 1g', 'one week out') },
      { from: 'vendor', daysAgo: 76.9, text: confirm('MPR', 'PO-517') },
    ],
  },
  {
    key: 'mpr-po-518',
    vendor: 'MPR',
    kind: 'po_confirmation',
    subject: 'Purchase order PO-518 – Mojave Pre-Roll Co.',
    messages: [
      { from: 'buyer', daysAgo: 32, text: poEmail('PO-518', 'MPR', '- PRE-BD-1G Blue Dream Pre-Roll 1g\n- PRE-OGK-1G OG Kush Pre-Roll 1g\n- PRE-SD-5PK Sour Diesel Mini Pre-Rolls 5-Pack\n- PRE-INF-1G Gelato Infused Pre-Roll 1g\n- PRE-JH-1G Jack Herer Pre-Roll 1g\n- PRE-GDP-1G Granddaddy Purple Pre-Roll 1g', 'one week out') },
      { from: 'vendor', daysAgo: 31.9, text: confirm('MPR', 'PO-518', '\n\nWe had to adjust our pricing about 5% this round (paper and packaging costs) — it\'s reflected on the invoice.') },
    ],
  },
  {
    key: 'mpr-checkin',
    vendor: 'MPR',
    kind: 'check_in',
    subject: 'Holiday pre-roll packs?',
    messages: [
      { from: 'vendor', daysAgo: 6, text: `Hey Sam,\n\nHope you're having a good week! We're doing our holiday gift tins again this year — 5 x 0.5g Blue Dream + Gelato mix, nice packaging, same wholesale as the 5-packs. Want me to drop a few samples off at the Oakland warehouse next time our driver is up?${signVendor(v('MPR'))}` },
      { from: 'buyer', daysAgo: 5.7, text: `Hi Ray — yes please, send a few samples with the next delivery and we'll show them to our dispensary buyers. Blue Dream singles are still our top pre-roll, so keep those coming too.${SIGN_BUYER}` },
    ],
  },
];

interface Mailboxes {
  google: Pick<Emulator, 'store' | 'outbox'>;
  now: Date;
}

/** IncomingMail plus the threading headers deliver() passes through to the raw message. */
type HistoricalMail = IncomingMail & { messageIdHeader: string; references?: string };

const messageId = (thread: HistoryThread, i: number) => `<history.${thread.key}.${i}@${thread.messages[i]!.from === 'buyer' ? 'goldencoastdistro.com' : v(thread.vendor).email.split('@')[1]}>`;

/** One historical message, addressed and dated (what `seedVendorHistory` delivers). */
export interface HistoricalMessage {
  thread: HistoryThread;
  /** Position in its thread. */
  index: number;
  from: string;
  to: string;
  /** `Re: ` for replies. */
  subject: string;
  text: string;
  date: Date;
  /** RFC 5322 Message-ID (stable: `<history.<thread>.<index>@<domain>>`). */
  messageIdHeader: string;
  inReplyTo?: string;
  references?: string;
  fromBuyer: boolean;
}

/**
 * The history as addressed, dated messages, oldest first: what the mailboxes receive. Also used by the
 * evals to index the same mail for semantic recall without booting the emulators (`threads` can add
 * scenario-specific threads).
 */
export function historyMessages(now: Date, threads: readonly HistoryThread[] = VENDOR_THREADS): HistoricalMessage[] {
  const all = threads.flatMap((thread) => thread.messages.map((m, i) => ({ thread, m, i }))).sort((a, b) => b.m.daysAgo - a.m.daysAgo);
  return all.map(({ thread, m, i }) => {
    const vendor = v(thread.vendor);
    const fromBuyer = m.from === 'buyer';
    const refs = thread.messages.slice(0, i).map((_, k) => messageId(thread, k));
    return {
      thread,
      index: i,
      from: fromBuyer ? `"${BUYER.name} (${COMPANY.name})" <${PURCHASING.email}>` : `"${vendor.contact} (${vendor.name})" <${vendor.email}>`,
      to: fromBuyer ? vendor.email : PURCHASING.email,
      subject: i === 0 ? thread.subject : `Re: ${thread.subject}`,
      text: m.text,
      date: new Date(now.getTime() - Math.round(m.daysAgo * 86_400_000)),
      messageIdHeader: messageId(thread, i),
      ...(refs.length ? { inReplyTo: refs.at(-1)!, references: refs.join(' ') } : {}),
      fromBuyer,
    };
  });
}

/**
 * Delivers the history into purchasing@ and the vendor mailboxes (SENT copy for the sender, INBOX copy
 * for the recipient, all read). Returns the Gmail ids of every historical message.
 */
export function seedVendorHistory({ google, now }: Mailboxes): Set<string> {
  const ids = new Set<string>();
  const purchasing = gmailMailbox(google, PURCHASING.email);
  for (const h of historyMessages(now)) {
    const vendorBox = gmailMailbox(google, v(h.thread.vendor).email);
    const mail: HistoricalMail = {
      from: h.from,
      to: h.to,
      subject: h.subject,
      text: h.text,
      date: h.date,
      messageIdHeader: h.messageIdHeader,
      ...(h.inReplyTo ? { inReplyTo: h.inReplyTo, references: h.references! } : {}),
    };
    const [senderBox, recipientBox] = h.fromBuyer ? [purchasing, vendorBox] : [vendorBox, purchasing];
    ids.add(senderBox.deliver({ ...mail, labelIds: ['SENT'] } as HistoricalMail).id);
    ids.add(recipientBox.deliver({ ...mail, labelIds: ['INBOX'] } as HistoricalMail).id);
  }
  return ids;
}
