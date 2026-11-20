# One container for the public demo: mocks, emulators, Inngest, agent server and dashboard behind a single
# port (scripts/start.ts). Postgres with pgvector runs separately; pass DATABASE_URL.
#
#   docker build --build-arg PUBLIC_URL=https://ops-agent.fly.dev -t ops-agent .
#   docker run -p 8080:8080 -e DATABASE_URL=... -e BETTER_AUTH_SECRET=... -e ANTHROPIC_API_KEY=... \
#     -e PUBLIC_URL=https://ops-agent.fly.dev ops-agent

FROM inngest/inngest:latest AS inngest

FROM oven/bun:1-debian
WORKDIR /app

COPY --from=inngest /usr/bin/inngest /usr/local/bin/inngest

COPY . .
RUN bun install --frozen-lockfile

# The dashboard is built against the public origin: the browser calls the agent there, through the proxy.
ARG PUBLIC_URL=http://localhost:8080
ENV VITE_API_URL=$PUBLIC_URL
RUN bun run --cwd apps/web build

ENV NODE_ENV=production PORT=8080 PUBLIC_URL=$PUBLIC_URL
EXPOSE 8080
CMD ["bun", "scripts/start.ts"]
