import type { LocationList } from '../api/schemas-ops';

/** The Distru location fields we show (a subset of the generated `Location`). */
export interface DistruLocationRow {
  id: string;
  name: string;
  address?: string | null;
  license?: { license_number: string } | null;
  deleted_at?: string | null;
}

/**
 * Own locations from Distru (`GET /locations`, an unlimited endpoint), through the same Distru
 * connector client the read tools use, so the ids match what agents and `POST /api/runs`
 * (`locationIds`) expect. Cached for `ttlMs` (default 5 min); a failed refresh serves the last good
 * list when there is one.
 */
export function createLocationsService(fetchAll: () => Promise<readonly DistruLocationRow[]>, options: { ttlMs?: number; now?: () => number } = {}) {
  const ttl = options.ttlMs ?? 5 * 60_000;
  const now = options.now ?? Date.now;
  let cache: { at: number; value: LocationList } | null = null;
  let inflight: Promise<LocationList> | null = null;

  const load = async (): Promise<LocationList> => {
    const rows = await fetchAll();
    const items = rows
      .filter((l) => !l.deleted_at)
      .map((l) => ({ id: l.id, name: l.name, licenseNumber: l.license?.license_number ?? null, address: l.address || null }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { items, fetchedAt: new Date(now()).toISOString() };
  };

  return {
    async list(): Promise<LocationList> {
      if (cache && now() - cache.at < ttl) return cache.value;
      inflight ??= load()
        .then((value) => {
          cache = { at: now(), value };
          return value;
        })
        .catch((err: unknown) => {
          if (cache) return cache.value;
          throw err;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
  };
}
