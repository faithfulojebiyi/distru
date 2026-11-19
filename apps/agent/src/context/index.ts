import { db } from '../db/client';
import { env } from '../env';
import { createAppContextStore, createAppContextSync } from './app-context';

/** Process-wide context store (Postgres schema `context`) and Distru sync (observer-wrapped client). */
export const appContextStore = createAppContextStore(db);
export const appContextSync = createAppContextSync(appContextStore, { baseUrl: env.DISTRU_BASE_URL, token: env.DISTRU_API_TOKEN });
