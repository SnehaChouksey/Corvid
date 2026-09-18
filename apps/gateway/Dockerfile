# syntax=docker/dockerfile:1

# Corvid API gateway — the long-lived backend service (ADR-33): the Hono REST surface, the durable
# LangGraph scan runtime, the in-process OOB-timeout sweep (ADR-35), and the composition root that
# spawns the Playwright/Chromium CRAWLER as an MCP subprocess (crawl-port.ts) and drives the E2B
# testing burst. It therefore needs Chromium + its system deps present — hence the Playwright base
# image (pinned to the repo's playwright version). This is NOT a serverless target; it runs as a
# persistent process (Render/Fly/Railway/a VM), per `02` §9.
#
# Build with the REPO ROOT as the build context (it needs the whole pnpm workspace + lockfile):
#   docker build -f apps/gateway/Dockerfile -t corvid-gateway .

# ── build stage: install the workspace, build the gateway + everything it spawns/imports ──────────
FROM mcr.microsoft.com/playwright:v1.62.1-noble AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

COPY . .

# Frozen install; strict-dep-builds=false because we deliberately don't run dependency build scripts
# (esbuild/msgpackr-extract, acknowledged in pnpm-workspace.yaml). The `...` builds @corvid/gateway
# AND its workspace deps — including @corvid/crawler (the MCP server the gateway spawns) and
# @corvid/burst-runner (whose esbuild bundle ships into the E2B sandbox).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --config.strict-dep-builds=false
RUN pnpm --filter @corvid/gateway... build

# ── runtime stage ─────────────────────────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.62.1-noble AS runtime
ENV NODE_ENV=production
# The base image preinstalls the browsers under /ms-playwright and sets PLAYWRIGHT_BROWSERS_PATH — the
# crawler subprocess and the report renderer both find Chromium there without a download.
ENV PORT=8787
WORKDIR /app/apps/gateway

# Copy the built workspace wholesale — pnpm's node_modules is a symlink farm rooted at /app; keeping the
# same absolute path preserves those links so @corvid/* (incl. the crawler server entry the gateway
# resolves), hono, the E2B SDK, and ioredis all resolve at runtime.
COPY --from=build /app /app

# Run as the Playwright image's unprivileged browser user.
USER pwuser
EXPOSE 8787

# Boot validates env fail-closed (§9): a missing safety-relevant var exits non-zero, never a
# half-started gateway. The host's restart policy turns that into a crash loop until the env is fixed.
CMD ["node", "dist/server.js"]
