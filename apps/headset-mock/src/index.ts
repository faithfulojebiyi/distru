import { createHeadsetMock } from './app';
import { isScenario } from './data';

const env = process.env;
const scenario = env.MOCK_SCENARIO ?? 'default';
if (!isScenario(scenario)) throw new Error(`Unknown MOCK_SCENARIO "${scenario}"`);

const mock = createHeadsetMock({ token: env.HEADSET_MOCK_TOKEN ?? 'headset-mock-token', scenario, now: env.MOCK_NOW || undefined });
const server = Bun.serve({ port: Number(env.PORT ?? 4600), fetch: mock.app.fetch });
console.log(`[headset-mock] http://localhost:${server.port}/v1  scenario=${mock.scenario}`);
