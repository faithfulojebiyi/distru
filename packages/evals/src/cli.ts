import './env-defaults';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { formatReport, reportFailed } from './report';
import { SCENARIOS } from './scenarios';
import { JsonFileSink, PostgresEvalSink, type EvalResultSink } from './sink';
import { REPORTS_DIR, runSuite } from './suite';

/**
 * bun run evals            offline: replay recordings, no network, no spend (CI)
 * bun run evals:record     record scenarios without a recording (one pass each), then replay
 * bun run evals:live       every call to the real model
 *
 * Flags: --scenario <id[,id]> (repeatable)  --tag <tag>  --no-judge  --force (re-record)
 *        --budget <usd> (record/live hard stop, default 5)  --sink pg (also write eval_run;
 *        needs DATABASE_URL)  --allow-missing  --verbose
 */
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    mode: { type: 'string', default: 'offline' },
    scenario: { type: 'string', multiple: true },
    tag: { type: 'string', multiple: true },
    'no-judge': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    budget: { type: 'string', default: '5' },
    sink: { type: 'string', multiple: true },
    'allow-missing': { type: 'boolean', default: false },
    verbose: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

const mode = z.enum(['offline', 'record', 'live']).parse(values.mode);
const ids = (values.scenario ?? []).flatMap((s) => s.split(',')).filter(Boolean);
const unknown = ids.filter((id) => !SCENARIOS.some((s) => s.id === id));
if (unknown.length) {
  console.error(`unknown scenario(s): ${unknown.join(', ')}\navailable: ${SCENARIOS.map((s) => s.id).join(', ')}`);
  process.exit(2);
}
const scenarios = SCENARIOS.filter((s) => (!ids.length || ids.includes(s.id)) && (!values.tag?.length || values.tag.some((t) => s.tags.includes(t))));

const json = new JsonFileSink(REPORTS_DIR);
const sinks: EvalResultSink[] = [json];
if (values.sink?.includes('pg')) {
  const url = process.env.DATABASE_URL;
  if (!url || url.includes('evals-placeholder')) {
    console.error('--sink pg needs DATABASE_URL (e.g. postgres://ops:ops@127.0.0.1:5482/ops)');
    process.exit(2);
  }
  sinks.push(new PostgresEvalSink(url));
}

const report = await runSuite({
  mode,
  scenarios,
  judge: !values['no-judge'],
  force: values.force,
  budgetUsd: Number(values.budget),
  sinks,
  log: (line) => console.log(line),
});
console.log(formatReport(report, { verbose: values.verbose }));
console.log(`report: ${json.path(report)}`);
process.exit(reportFailed(report, { allowMissing: values['allow-missing'] }) ? 1 : 0);
