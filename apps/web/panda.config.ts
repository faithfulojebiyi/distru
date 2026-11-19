import { defineConfig } from '@pandacss/dev';

export default defineConfig({
  preflight: true,
  jsxFramework: 'react',
  designSystem: '@ops/ui',
  include: ['./src/**/*.{ts,tsx}'],
  exclude: [],
  outdir: './src/styled-system',
  prefix: 'ops',
});
