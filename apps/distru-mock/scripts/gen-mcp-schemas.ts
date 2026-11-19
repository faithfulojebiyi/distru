/**
 * Generates `src/mcp/schemas.gen.ts` from Distru's MCP tool pages (docs/research/mcptools/<tool>.md),
 * so every mocked tool is traceable to the docs:
 *
 * - kind (read/write) and the external systems a write reaches, from the page's first line
 *   ("`distru-x`, a write tool. Also reaches: QuickBooks.");
 * - the description the model reads, from the "What the AI reads" section (verbatim);
 * - a zod input schema from the Inputs table (types, enums, required flags, nesting via `a.b` / `a[].b`,
 *   field descriptions). The common inputs (`intent`, `userSatisfactionEstimate`) are added by the server.
 *
 *   bun run scripts/gen-mcp-schemas.ts        (or: bun run gen:mcp-schemas)
 *
 * Hand fixes live in the tool implementations (src/mcp/tools.ts), not in the generated file.
 */
import { join } from 'node:path';

/** The tools the mock implements (Distru names without the `distru-` prefix). */
export const MOCKED_TOOLS = [
  'get-me',
  'search-products',
  'get-product',
  'report-inventory-valuation',
  'report-inventory-assets',
  'search-purchase-orders',
  'get-purchase-order',
  'mutate-purchase-order',
  'search-companies',
  'get-company',
  'search-packages',
  'get-package',
  'search-test-results',
  'search-sales-orders',
  'get-sales-order',
  'adjust-inventory',
  'mutate-task',
  'search-tasks',
  'search-users',
  'get-record-history',
  'search-activity',
  'email-pdf',
  // DistruCommerce menus (+ the product field that caps what one buyer may order)
  'search-menus',
  'get-menu-settings',
  'search-menu-products',
  'search-menu-collections',
  'mutate-menu',
  'mutate-product',
] as const;

const ROOT = join(import.meta.dir, '..');
const DOCS = join(ROOT, '../../docs/research/mcptools');
const OUT = join(ROOT, 'src/mcp/schemas.gen.ts');

interface Field {
  name: string;
  type: string;
  required: boolean;
  description: string;
  children: Field[];
}

interface ToolPage {
  slug: string;
  name: string;
  title: string;
  kind: 'read' | 'write';
  reaches: string[];
  summary: string;
  description: string;
  fields: Field[];
}

/** Splits a markdown table row on unescaped pipes. */
function cells(row: string): string[] {
  return row
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((c) => c.trim().replace(/\\\|/g, '|'));
}

const REACH_IDS: Record<string, string> = {
  QuickBooks: 'quickbooks',
  Metrc: 'metrc',
  BioTrack: 'biotrack',
  LeafLink: 'leaflink',
  POS: 'pos',
  'Your POS': 'pos',
  Trym: 'trym',
  Email: 'email',
};

export function parsePage(slug: string, md: string): ToolPage {
  const lines = md.split('\n');
  const title = lines[0]!.replace(/^#\s*/, '').trim();
  const head = /^`(distru-[a-z0-9-]+)`, a (read|write) tool\.(?: Also reaches: (.+)\.)?$/.exec(lines[2]!.trim());
  if (!head) throw new Error(`${slug}: unexpected header line: ${lines[2]}`);
  const reaches = (head[3] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => REACH_IDS[s] ?? s.toLowerCase());
  const summary = lines[4]!.trim();
  const aiIdx = lines.findIndex((l) => l.trim() === '## What the AI reads');
  if (aiIdx < 0) throw new Error(`${slug}: no "What the AI reads" section`);
  const description = lines
    .slice(aiIdx + 1)
    .join('\n')
    .trim();

  const inStart = lines.findIndex((l) => l.trim() === '## Inputs');
  const inEnd = lines.findIndex((l, i) => i > inStart && l.startsWith('## '));
  const rows = lines.slice(inStart + 1, inEnd).filter((l) => l.startsWith('| `'));
  const roots: Field[] = [];
  const byPath = new Map<string, Field>();
  for (const row of rows) {
    const [rawName = '', type = '', req = '', desc = ''] = cells(row);
    const path = rawName.replace(/`/g, '');
    const m = /^(.*?)(\[\])?\.([^.]+)$/.exec(path);
    const field: Field = { name: m ? m[3]! : path, type, required: req === 'Yes', description: desc, children: [] };
    byPath.set(path, field);
    if (m) {
      const parent = byPath.get(m[1]!);
      if (!parent) throw new Error(`${slug}: parent of ${path} not found`);
      parent.children.push(field);
    } else roots.push(field);
  }
  return { slug, name: head[1]!, title, kind: head[2] as 'read' | 'write', reaches, summary, description, fields: roots };
}

const lit = (s: string) => JSON.stringify(s);

function enumValues(type: string): string[] {
  const after = type.slice(type.indexOf(':') + 1);
  return [...after.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
}

/** zod source for one field (without `.optional()`). */
export function zodFor(f: Field, path: string): string {
  const t = f.type;
  const nullable = /\bor null\b/.test(t);
  let base: string;
  if (t.startsWith('`enum[]`')) base = `z.array(z.enum(${JSON.stringify(enumValues(t))}))`;
  else if (t.startsWith('`enum`')) base = `z.enum(${JSON.stringify(enumValues(t))})`;
  else if (t.startsWith('`object[]`')) base = `z.array(${objectFor(f.children, path)})`;
  else if (t.startsWith('`object`')) base = objectFor(f.children, path);
  else if (t.startsWith('`string or number`')) base = 'z.union([z.string(), z.number()])';
  else if (t.startsWith('`string or string[]`')) base = 'z.union([z.string(), z.array(z.string())])';
  else if (t.startsWith('`string[]`')) base = 'z.array(z.string())';
  else if (t.startsWith('`string`')) base = 'z.string()';
  else if (t.startsWith('`integer`')) base = f.name === 'limit' ? 'z.number().int().min(1).max(100)' : 'z.number().int()';
  else if (t.startsWith('`number`')) base = 'z.number()';
  else if (t.startsWith('`boolean`')) base = 'z.boolean()';
  else throw new Error(`${path}: unsupported type ${t}`);
  if (nullable) base += '.nullable()';
  if (f.description) base += `.describe(${lit(f.description)})`;
  return base;
}

function objectFor(fields: Field[], path: string): string {
  if (!fields.length) return 'z.object({}).passthrough()';
  const props = fields.map((f) => `${JSON.stringify(f.name)}: ${zodFor(f, `${path}.${f.name}`)}${f.required ? '' : '.optional()'}`);
  return `z.object({ ${props.join(', ')} })`;
}

const camel = (slug: string) => slug.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

export function generate(pages: ToolPage[]): string {
  const out: string[] = [
    '// Generated by scripts/gen-mcp-schemas.ts from docs/research/mcptools/*.md — do not edit by hand.',
    '// Regenerate: bun run gen:mcp-schemas',
    "import { z } from 'zod';",
    '',
    'export interface DistruToolDef {',
    '  /** Distru tool name, e.g. `distru-get-me`. */',
    '  name: string;',
    '  /** Page title, used as the MCP tool title. */',
    '  title: string;',
    "  kind: 'read' | 'write';",
    '  /** External systems a write can reach (from the page header). */',
    '  reaches: readonly string[];',
    '  /** One-line summary under the page title. */',
    '  summary: string;',
    '  /** Verbatim "What the AI reads" text: the description the model sees. */',
    '  description: string;',
    '  /** Source page, relative to the repo root. */',
    '  doc: string;',
    '  /** The tool-specific inputs (common inputs are added by the server). */',
    '  input: z.ZodObject;',
    '}',
    '',
  ];
  for (const p of pages) {
    out.push(`export const ${camel(p.slug)} = {`);
    out.push(`  name: ${lit(p.name)},`);
    out.push(`  title: ${lit(p.title)},`);
    out.push(`  kind: ${lit(p.kind)},`);
    out.push(`  reaches: ${JSON.stringify(p.reaches)},`);
    out.push(`  summary: ${lit(p.summary)},`);
    out.push(`  description: ${lit(p.description)},`);
    out.push(`  doc: ${lit(`docs/research/mcptools/${p.slug}.md`)},`);
    out.push(`  input: ${objectFor(p.fields, p.slug)},`);
    out.push('} satisfies DistruToolDef;');
    out.push('');
  }
  out.push('export const TOOL_DEFS = {');
  for (const p of pages) out.push(`  ${lit(p.name)}: ${camel(p.slug)},`);
  out.push('} as const;');
  out.push('');
  out.push('export type DistruToolName = keyof typeof TOOL_DEFS;');
  out.push('');
  return out.join('\n');
}

if (import.meta.main) {
  const pages: ToolPage[] = [];
  for (const slug of MOCKED_TOOLS) pages.push(parsePage(slug, await Bun.file(join(DOCS, `${slug}.md`)).text()));
  await Bun.write(OUT, generate(pages));
  const proc = Bun.spawnSync(['bunx', 'prettier', '--write', '--print-width', '140', '--single-quote', OUT], { stdout: 'ignore', stderr: 'ignore' });
  console.log(`wrote ${pages.length} tool schemas → src/mcp/schemas.gen.ts${proc.exitCode === 0 ? ' (prettier)' : ''}`);
}
