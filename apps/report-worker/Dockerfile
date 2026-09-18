# syntax=docker/dockerfile:1

# Corvid report-worker — the durable BullMQ worker (ADR-34) that consumes the report queue, generates
# the verified-only report, renders it to PDF with Chromium, stores it, and completes the scan. It is a
# continuous background worker (no HTTP), and it renders PDFs via Playwright — hence the Playwright base
# image. Runs as a persistent process alongside the gateway (`02` §9); on Render this is a Background
# Worker, not a web service.
#
# Build with the REPO ROOT as the build context:
#   docker build -f apps/report-worker/Dockerfile -t corvid-report-worker .

# ── build stage ───────────────────────────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.62.1-noble AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

COPY . .

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --config.strict-dep-builds=false
RUN pnpm --filter @corvid/report-worker... build

# ── runtime stage ─────────────────────────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.62.1-noble AS runtime
ENV NODE_ENV=production
# Chromium is preinstalled in the base image (PLAYWRIGHT_BROWSERS_PATH=/ms-playwright); the PDF renderer
# feeds it self-contained HTML with no network access.
WORKDIR /app/apps/report-worker

COPY --from=build /app /app

USER pwuser

# A worker has no port; it drains the Redis queue until stopped. Boot validates env fail-closed (§9).
CMD ["node", "dist/server.js"]
