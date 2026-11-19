/** Minimal, safe Markdown → text/HTML for PO emails. Everything is escaped; only a tiny subset renders. */

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);

/** http(s) only; anything else (javascript:, data:) is rendered as plain text. */
const safeUrl = (url: string): string | null => (/^https?:\/\/[^\s<>"']+$/i.test(url) ? url : null);

function inline(escaped: string): string {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label: string, url: string) => {
      // url is already HTML-escaped; un-escape &amp; for the check only.
      const ok = safeUrl(url.replace(/&amp;/g, '&'));
      return ok ? `<a href="${url}">${label}</a>` : m;
    });
}

/** Paragraphs, line breaks, `- ` bullet lists, **bold**, *italic*, [links](https://…). */
export function markdownToHtml(md: string): string {
  const blocks = md.replace(/\r\n?/g, '\n').trim().split(/\n{2,}/);
  const html = blocks.map((block) => {
    const lines = block.split('\n');
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      return `<ul>${lines.map((l) => `<li>${inline(escapeHtml(l.replace(/^\s*[-*]\s+/, '')))}</li>`).join('')}</ul>`;
    }
    return `<p>${lines.map((l) => inline(escapeHtml(l))).join('<br>')}</p>`;
  });
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5">${html.join('\n')}</body></html>`;
}

/** Plain-text alternative: Markdown emphasis markers dropped, links as `label (url)`. */
export function markdownToText(md: string): string {
  return md
    .replace(/\r\n?/g, '\n')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
    .trim();
}
