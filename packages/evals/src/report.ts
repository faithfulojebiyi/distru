import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ScenarioResultSchema, type ScenarioResult } from './runner';

export const EvalReportSchema = z
  .object({
    batchId: z.string(),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
    mode: z.enum(['offline', 'record', 'live']),
    model: z.string(),
    judge: z.boolean(),
    gitSha: z.string().nullable(),
    totals: z.object({
      scenarios: z.number().int(),
      passed: z.number().int(),
      failed: z.number().int(),
      pending: z.number().int(),
      missingRecording: z.number().int(),
      costUsd: z.number(),
      realCostUsd: z.number(),
      tokens: z.number().int(),
      latencyMs: z.number(),
    }),
    scenarios: z.array(ScenarioResultSchema),
  })
  .meta({ id: 'EvalReport' });
export type EvalReport = z.infer<typeof EvalReportSchema>;

/** Git sha without running git: CI env vars, else .git/HEAD (+ the ref file / packed-refs). */
export function gitSha(root: string): string | null {
  const fromEnv = process.env.GITHUB_SHA ?? process.env.GIT_SHA ?? process.env.CI_COMMIT_SHA;
  if (fromEnv) return fromEnv;
  try {
    const head = join(root, '.git', 'HEAD');
    if (!existsSync(head)) return null;
    const content = readFileSync(head, 'utf8').trim();
    const ref = /^ref: (.+)$/.exec(content)?.[1];
    if (!ref) return content || null;
    const refFile = join(root, '.git', ref);
    if (existsSync(refFile)) return readFileSync(refFile, 'utf8').trim();
    const packed = join(root, '.git', 'packed-refs');
    if (existsSync(packed)) return readFileSync(packed, 'utf8').split('\n').find((l) => l.endsWith(` ${ref}`))?.split(' ')[0] ?? null;
    return null;
  } catch {
    return null;
  }
}

export function buildReport(args: { batchId: string; startedAt: Date; mode: EvalReport['mode']; model: string; judge: boolean; gitSha: string | null; scenarios: ScenarioResult[]; realCostUsd: number }): EvalReport {
  const s = args.scenarios;
  const ran = s.filter((r) => r.status === 'pass' || r.status === 'fail' || r.status === 'error');
  return {
    batchId: args.batchId,
    startedAt: args.startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    mode: args.mode,
    model: args.model,
    judge: args.judge,
    gitSha: args.gitSha,
    totals: {
      scenarios: s.length,
      passed: s.filter((r) => r.status === 'pass').length,
      failed: s.filter((r) => r.status === 'fail' || r.status === 'error').length,
      pending: s.filter((r) => r.status === 'pending' || r.status === 'skipped').length,
      missingRecording: s.filter((r) => r.status === 'missing_recording').length,
      costUsd: round(ran.reduce((n, r) => n + r.usage.costUsd, 0)),
      realCostUsd: round(args.realCostUsd),
      tokens: ran.reduce((n, r) => n + r.usage.inputTokens + r.usage.outputTokens, 0),
      latencyMs: ran.reduce((n, r) => n + r.latencyMs, 0),
    },
    scenarios: s,
  };
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** The suite fails (non-zero exit) on any failed / errored scenario or a missing recording. */
export function reportFailed(report: EvalReport, options: { allowMissing?: boolean } = {}): boolean {
  return report.totals.failed > 0 || (!options.allowMissing && report.totals.missingRecording > 0);
}

// ── console ─────────────────────────────────────────────────────────────────────────────────────

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = paint(32);
const red = paint(31);
const yellow = paint(33);
const dim = paint(2);
const bold = paint(1);

const BADGE: Record<ScenarioResult['status'], string> = {
  pass: green('PASS'),
  fail: red('FAIL'),
  error: red('ERR '),
  pending: yellow('PEND'),
  skipped: yellow('SKIP'),
  missing_recording: yellow('NREC'),
};

export function formatReport(report: EvalReport, options: { verbose?: boolean } = {}): string {
  const out: string[] = [];
  out.push(bold(`Ops Agent evals — ${report.mode} — ${report.model}${report.judge ? ' + judge' : ''}`) + dim(`  batch ${report.batchId}  sha ${report.gitSha?.slice(0, 10) ?? 'n/a'}`));
  for (const r of report.scenarios) {
    const usage = r.usage.llmCalls ? dim(`  ${r.usage.llmCalls} calls · ${(r.usage.inputTokens + r.usage.outputTokens).toLocaleString('en-US')} tok · $${r.usage.costUsd.toFixed(4)} · ${(r.latencyMs / 1000).toFixed(1)}s`) : '';
    const counts = r.assertions.length ? ` ${r.passed}/${r.assertions.filter((a) => a.status !== 'skipped').length}` : '';
    out.push(`${BADGE[r.status]} ${r.id}${counts}${usage}`);
    if (r.status === 'pending' || r.status === 'missing_recording') out.push(dim(`       ${r.reason ?? ''}`));
    for (const a of r.assertions) {
      if (a.status === 'pass' && !options.verbose) continue;
      const mark = a.status === 'pass' ? green('✓') : a.status === 'fail' ? red('✗') : yellow('–');
      out.push(`       ${mark} ${a.label} ${dim(`— ${a.detail}`)}`);
    }
    if (r.status === 'error' && r.reason) out.push(red(`       error: ${r.reason.slice(0, 300)}`));
  }
  const t = report.totals;
  out.push(
    bold(
      `${t.passed} passed, ${t.failed} failed, ${t.pending} pending, ${t.missingRecording} missing recording` +
        ` · ${t.tokens.toLocaleString('en-US')} tokens · $${t.costUsd.toFixed(4)} (as recorded)` +
        (report.mode === 'offline' ? ' · $0 spent' : ` · $${t.realCostUsd.toFixed(4)} spent now`),
    ),
  );
  return out.join('\n');
}
