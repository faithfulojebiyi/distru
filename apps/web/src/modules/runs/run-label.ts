// Ops Agent addition (no carbonme counterpart): one human label per run, shared by the sidebar's Runs section, the
// Runs page and the Overview's Runs tab, so a run reads the same everywhere and never as its id.
import type { RunSummary } from '../../api/generated/opsAgentAPI.schemas';

const WORKFLOW_LABELS: Record<string, string> = { restock: 'Restock', 'vendor-reply': 'Vendor reply' };

type LabelledRun = Pick<RunSummary, 'workflowId' | 'proposal'> & Partial<Pick<RunSummary, 'scope' | 'outcome'>>;

/** The first few words of the trigger note, without a "Demo:" style lead-in or trailing period. */
const noteWords = (note: string, words = 5) => {
  const clean = note.replace(/^\s*[A-Z][a-z]+:\s+/, '').replace(/[.\s]+$/, '');
  const parts = clean.split(/\s+/);
  const head = parts.slice(0, words).join(' ');
  return parts.length > words ? `${head}…` : head;
};

/**
 * "Restock · Oakland Warehouse", "Restock · all warehouses", "Vendor reply · PO-521", "Restock · LA — nothing to
 * order". The place comes from the run's scope (location names, else ids resolved with `locations`), then the
 * proposal title's place ("Restock 5 vendors · Oakland Warehouse"), then the trigger note's first words.
 */
export const runLabel = (run: LabelledRun, locations: ReadonlyMap<string, string> = new Map()): string => {
  const kind = WORKFLOW_LABELS[run.workflowId] ?? 'Run';
  const title = run.proposal?.title ?? '';
  const scope = run.scope;
  const suffix = run.outcome === 'nothing_to_order' ? ' — nothing to order' : '';

  if (run.workflowId === 'vendor-reply') {
    const po = /\bPO-\d+\b/.exec(title)?.[0];
    if (po) return `${kind} · ${po}${suffix}`;
  }
  const scoped = (scope?.locationIds ?? []).map((id) => locations.get(id)).filter((name): name is string => Boolean(name));
  const names = scope?.locationIds.length ? (scoped.length ? scoped : scope.locationNames) : [];
  if (names.length === 1) return `${kind} · ${names[0]}${suffix}`;
  if (names.length > 1) return `${kind} · ${names.length} warehouses${suffix}`;
  const place = title.includes(' · ') ? title.split(' · ').at(-1) : null;
  if (place && !/^\d+ locations?$/.test(place)) return `${kind} · ${place}${suffix}`;
  if (scope && !scope.locationIds.length && !scope.vendorIds.length) {
    if (scope.locationNames.length === 1) return `${kind} · ${scope.locationNames[0]}${suffix}`;
    return `${kind} · all warehouses${suffix}`;
  }
  if (scope?.scenarioNote) return `${kind} · ${noteWords(scope.scenarioNote)}${suffix}`;
  const vendors = /(\d+ vendors?)/.exec(title)?.[1];
  return `${kind} · ${vendors ?? 'all warehouses'}${suffix}`;
};
