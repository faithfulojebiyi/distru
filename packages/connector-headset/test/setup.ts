/** The headset mock in-process (no network) behind the real client + registry. */
import { createHeadsetMock, type ScenarioName } from '@ops/headset-mock';
import { agentPrincipal, Registry } from '@ops/harness';
import { createHeadsetContext, headsetConnector, type FetchLike } from '../src';

export const NOW = '2026-11-19T12:00:00Z';
export const analyst = agentPrincipal('inventory-analyst', 'Inventory Analyst');

export function setup(scenario: ScenarioName = 'default') {
  const mock = createHeadsetMock({ now: NOW, scenario });
  const requests: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push(url);
    return mock.app.request(url, init);
  };
  const ctx = createHeadsetContext({ baseUrl: 'http://headset.test', token: 'headset-mock-token', fetch });
  const registry = Registry.fromConnectors([headsetConnector]);
  const read = (tool: string, input: unknown = {}) => registry.runReadTool(ctx, analyst, `headset.${tool}`, input);
  return { mock, ctx, registry, read, requests };
}
