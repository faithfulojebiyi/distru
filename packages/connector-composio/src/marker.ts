/**
 * Idempotency markers for writes whose systems have no idempotency key (Gmail, Calendar). The
 * harness key is hashed into one alphanumeric token (`opsidem` + 24 hex) so it survives Gmail's
 * and Calendar's tokenising search: `in:sent opsidem…` / events `q=opsidem…` find exactly the
 * write made with that key. It is appended as a short `Ref:` footer at execute time (the approver
 * sees the exact message; the footer is the only addition, and the README says so).
 */
import { createHash } from 'node:crypto';

export const markerFor = (idempotencyKey: string): string => `opsidem${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 24)}`;

/** Appends the `Ref:` footer once (plain text or HTML body). */
export function stampBody(body: string, idempotencyKey: string, html = false): string {
  const marker = markerFor(idempotencyKey);
  if (body.includes(marker)) return body;
  return html ? `${body}\n<p style="color:#888;font-size:11px">Ref: ${marker}</p>` : `${body}\n\nRef: ${marker}`;
}

/** Strips any `Ref: opsidem…` footer (for showing a sent body back to an agent). */
export const stripMarker = (body: string): string => body.replace(/\n*(<p[^>]*>)?Ref: opsidem[0-9a-f]{24}(<\/p>)?\s*$/i, '').trimEnd();
