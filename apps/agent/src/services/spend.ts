import { SpendLedger } from '../api/cost-guard';
import { env } from '../env';

/** Process-wide estimated LLM spend for today (UTC), fed by every agent's finished calls (src/mastra/index.ts). */
export const appSpend = new SpendLedger({ inputUsdPerMTok: env.LLM_INPUT_USD_PER_MTOK, outputUsdPerMTok: env.LLM_OUTPUT_USD_PER_MTOK });
