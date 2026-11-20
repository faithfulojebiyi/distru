/**
 * The restock proposal's weekly reorder log: with Composio connected (apps/emulators world, Google
 * Sheets toolkit) and `crossTool.reorderLog` set, the workflow appends one last op,
 * `composio.sheets.append_rows`, one row per PO line whose PO column references the PO op. Approve →
 * the rows land in the sheet with the real PO numbers and the idempotency marker; re-execute writes
 * nothing. Without Composio the op is left out with a note. The Planner gets `sheets.read_rows`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { googleSheets } from '@ops/emulators';
import { createWorld, REORDER_LOG_HEADER, SHEETS, type World } from '@ops/emulators-server';
import { createComposioClient, createComposioConnector, markerFor } from '@ops/connector-composio';
import type { Proposal } from '@ops/harness';
import { z } from 'zod';
import { toolDescriptorsFor } from '../src/mastra/tools/harness-tools';
import { PURCHASE_ACTION, SHEET_ACTION } from '../src/mastra/workflows/cross-tool';
import { RestockResultSchema } from '../src/mastra/workflows/restock';
import { resumeRunOnDecision } from '../src/services/runs';
import { restockEnv, type RestockEnv } from './fixtures/restock-env';

const SCOPE_SKUS = ['VAP-BD-1G', 'PRE-BD-1G', 'FLW-OGK-35', 'FLW-BD-35'];
const BUYER = 'purchasing@goldencoastdistro.com';
const REORDER_LOG = { spreadsheet: SHEETS.reorderLog.id, sheet: SHEETS.reorderLog.tab };

let world: World;
let server: ReturnType<typeof Bun.serve>;
let baseURL: string;

beforeAll(() => {
  world = createWorld({ pollMs: 0 });
  server = Bun.serve({ port: 0, fetch: (r) => world.fetch(r) });
  baseURL = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await world.close();
  server.stop(true);
});

const composio = () =>
  createComposioConnector({
    client: createComposioClient({ apiKey: world.config.composioApiKey, baseURL, userId: 'golden-coast' }),
    toolkits: ['googlesheets'],
    id: 'composio',
    spreadsheets: [
      { id: SHEETS.vendorPrices.id, name: SHEETS.vendorPrices.title },
      { id: SHEETS.reorderLog.id, name: SHEETS.reorderLog.title, appendable: true },
    ],
  });

const logRows = () => googleSheets(world.google, BUYER).values(SHEETS.reorderLog.id, SHEETS.reorderLog.tab);

async function suspendedProposal(env: RestockEnv): Promise<{ runId: string; p: Proposal }> {
  const oakland = (await env.locations()).find((l) => l.name.startsWith('Oakland'))!;
  const productIds = await Promise.all(SCOPE_SKUS.map((sku) => env.productId(sku)));
  const { runId } = await env.launcher.start({ triggeredBy: 'test', locationIds: [oakland.id], productIds });
  await env.waitFor(runId, ['suspended']);
  return { runId, p: (await env.findProposalByRunId(runId))! };
}

const LogPayload = z.object({ spreadsheetId: z.string(), range: z.string(), values: z.array(z.array(z.union([z.string(), z.number()]))) });
const PoInput = z.object({ lines: z.array(z.object({ product_id: z.string(), quantity: z.number(), unit_price: z.number() })) });

describe('restock → weekly reorder log (Google Sheets through Composio)', () => {
  test('one append op last, a row per PO line referencing its PO; approve → rows with real PO numbers + marker; idempotent', async () => {
    world.reset();
    const before = logRows().length;
    expect(logRows()[0]).toEqual([...REORDER_LOG_HEADER]);
    const env = await restockEnv({ composio, crossTool: { reorderLog: REORDER_LOG } });

    // The Planner may read the vendor price sheet (never write it: no propose tool for sheets).
    const plannerTools = toolDescriptorsFor(env.connectors.registry, 'procurementPlanner').map((d) => d.toolName);
    expect(plannerTools).toContain('composio_sheets_read_rows');
    expect(plannerTools).not.toContain('propose_composio_sheets_append_rows');

    const { runId, p } = await suspendedProposal(env);
    const last = p.ops.at(-1)!;
    expect(last.action).toBe(SHEET_ACTION);
    expect(last.risk).toBe('medium');
    expect(p.ops.filter((op) => op.action === SHEET_ACTION)).toHaveLength(1);
    expect(p.meta.crossTool).toContainEqual({ index: last.index, action: SHEET_ACTION, forPo: null, source: 'workflow' });

    const pos = p.ops.filter((op) => op.action === PURCHASE_ACTION);
    const payload = LogPayload.parse(last.payload);
    expect(payload).toMatchObject({ spreadsheetId: SHEETS.reorderLog.id, range: 'Reorders!A1' });
    expect(payload.values).toHaveLength(pos.reduce((n, po) => n + PoInput.parse(po.input).lines.length, 0));
    for (const row of payload.values) {
      expect(row).toHaveLength(9);
      expect(row[0]).toBe('2026-11-19');
      expect(row[1]).toBe(runId);
      expect(String(row[2])).toMatch(/^\{\{op:\d+\.purchase_number\}\}$/);
      expect(pos.map((po) => `{{op:${po.index}.purchase_number}}`)).toContain(String(row[2]));
    }
    expect(logRows()).toHaveLength(before); // nothing written while proposing

    const decided = await env.harness.decide({ ctx: env.contexts.read, principal: env.approver, proposalId: p.id, decision: 'approve', reason: 'ok' });
    await resumeRunOnDecision(env.launcher)(decided);
    const result = RestockResultSchema.parse((await env.waitFor(runId, ['success'], 30_000)).result);
    expect(result).toMatchObject({ status: 'executed', verified: true });

    const done = await env.harness.get(p.id);
    const logOp = done.ops.at(-1)!;
    expect(logOp).toMatchObject({ status: 'executed', result: { mismatches: [], deduplicated: false } });
    const rows = logRows();
    expect(rows).toHaveLength(before + payload.values.length);
    const appended = rows.slice(before);
    const poNumbers = done.ops.filter((op) => op.action === PURCHASE_ACTION).map((op) => String(op.result!.outputs!.purchase_number));
    for (const row of appended) {
      expect(poNumbers).toContain(row[2] ?? '');
      expect(row[3]).toBeTruthy(); // vendor name
      expect(row[9]).toBe(markerFor(logOp.idempotencyKey));
    }

    await env.harness.execute({ ctx: env.contexts.execute, proposalId: p.id });
    expect(logRows()).toHaveLength(before + payload.values.length);
  });

  test('without Composio the log op is left out and the rationale says so', async () => {
    const env = await restockEnv({ crossTool: { reorderLog: REORDER_LOG } });
    const { p } = await suspendedProposal(env);
    expect(p.ops.some((op) => op.action === SHEET_ACTION)).toBe(false);
    expect(p.rationale).toContain('the weekly reorder log was not updated');
  });

  test('off by default: no reorder-log op even with Composio connected', async () => {
    world.reset();
    const env = await restockEnv({ composio });
    const { p } = await suspendedProposal(env);
    expect(p.ops.some((op) => op.action === SHEET_ACTION)).toBe(false);
  });
});
