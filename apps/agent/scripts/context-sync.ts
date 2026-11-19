/**
 * One context pass outside Inngest (what the `context-sync` cron does): Distru sync (DISTRU_BASE_URL),
 * account profile, then learning from every decided proposal and policy edit. Prints a short report.
 *
 *   bun run --cwd apps/agent context:sync
 */
import { sql } from '../src/db/client';
import { db } from '../src/db/client';
import { appContextStore, appContextSync } from '../src/context';
import { learnFromHistory, memoriesList, onboarding, profileSummary, syncAndProfile } from '../src/context/app-context';

const out = await syncAndProfile(appContextSync, appContextStore, () => learnFromHistory(db, appContextStore));
console.log(JSON.stringify(out, null, 2));
const profile = await profileSummary(appContextStore);
console.log(`profile v${profile.version}: ${profile.vendors.length} vendors, ${profile.products.length} products`);
for (const v of profile.vendors) console.log(`  vendor ${v.name}: promised ${v.promisedLeadTimeDays ?? 'n/a'}d, actual ${v.actualLeadTimeDays ?? 'n/a'}d (n=${v.leadTimeSamples}), on-time ${v.onTimePct ?? 'n/a'}%, fill ${v.fillRatePct ?? 'n/a'}%`);
const memories = await memoriesList(appContextStore, { limit: 20 });
console.log(`${memories.length} live memories`);
for (const m of memories) console.log(`  [${m.scope}${m.scopeId ? `:${m.scopeId.slice(0, 8)}` : ''}] ${m.statement} (conf ${m.effectiveConfidence.toFixed(2)}, evidence ${m.evidenceCount})`);
const report = await onboarding(appContextStore);
console.log(`onboarding: completeness ${report.completeness.score}, ${report.vendorsMissingLeadTimes.length} vendor(s) missing lead times, ${report.suggestedPolicy.length} policy suggestion(s); issues: ${report.completeness.issues.join(' | ') || 'none'}`);
await sql.end();
process.exit(0);
