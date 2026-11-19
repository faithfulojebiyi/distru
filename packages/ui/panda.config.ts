import { defineConfig } from '@pandacss/dev';

import { opsUi } from './src/theme/preset';

/** The Ops design system: tokens, recipes and components shared by the web app. */
export default defineConfig({
  preflight: true,
  jsxFramework: 'react',
  include: ['./src/**/*.{ts,tsx}'],
  exclude: ['./src/**/*.spec.{ts,tsx}'],
  importMap: '@ops/ui',
  outdir: './styled-system',
  prefix: 'ops',
  presets: ['@pandacss/preset-base', opsUi],
});
