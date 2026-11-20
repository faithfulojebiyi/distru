// Production server for the built dashboard: static assets from dist/client, everything else through the
// TanStack Start server entry (SSR).
import { join, normalize } from 'node:path';

// @ts-expect-error built at deploy time by `vite build`
import server from './dist/server/server.js';

const CLIENT = join(import.meta.dir, 'dist/client');

Bun.serve({
  port: Number(process.env.PORT ?? 3050),
  hostname: process.env.HOST ?? '0.0.0.0',
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname !== '/') {
      const path = normalize(join(CLIENT, decodeURIComponent(pathname)));
      if (path.startsWith(CLIENT + '/')) {
        const file = Bun.file(path);
        if (await file.exists()) {
          const immutable = pathname.startsWith('/assets/');
          return new Response(file, {
            headers: { 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600' },
          });
        }
      }
    }
    return server.fetch(req);
  },
});
