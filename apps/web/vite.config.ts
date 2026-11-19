import { fileURLToPath } from 'node:url';

import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { uiSourceAlias } from '@ops/ui/source-alias';
import { defineConfig, loadEnv } from 'vite';
import { resolveApiUrl } from './src/config/api-url.ts';

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, r('.'), 'VITE_');
  resolveApiUrl(mode, process.env.VITE_API_URL ?? env.VITE_API_URL);

  return {
    server: { port: 3050 },
    resolve: { alias: [uiSourceAlias] },
    plugins: [tanstackStart(), react()],
  };
});
