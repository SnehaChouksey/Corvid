# syntax=docker/dockerfile:1

# OOB callback listener (ADR-09 / D-16) — the self-hosted Interactsh-style service that records a
# target's out-of-band callback so the deterministic gate (@corvid/verify) can confirm blind SSRF.
#
# Build with the REPO ROOT as the build context (it needs the whole pnpm workspace + lockfile):
#   docker build -f apps/oob-listener/Dockerfile -t corvid-oob-listener .
# The scoped ignore file apps/oob-listener/Dockerfile.dockerignore trims the context (BuildKit).

# ── build stage: install the workspace, build only the oob-listener slice ─────────────────────────
FROM node:24-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# Copy the whole monorepo. A workspace build resolves its graph from every package.json, so a partial
# copy buys little; the ignore file already drops node_modules/dist/.git/.turbo.
COPY . .

# Frozen install against the committed lockfile, then build the oob-listener AND its workspace deps
# (`...` = include dependencies). tsc rewrites .ts import specifiers to .js, so dist/ runs under node.
# strict-dep-builds=false: we deliberately don't run dependency build scripts (esbuild/msgpackr-extract
# work without them, acknowledged in pnpm-workspace.yaml); this keeps that a warning, not a CI-hard error.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --config.strict-dep-builds=false
RUN pnpm --filter @corvid/oob-listener... build

# ── runtime stage ─────────────────────────────────────────────────────────────────────────────────
FROM node:24-slim AS runtime
ENV NODE_ENV=production
# In-container listen port. Map the host's :80 to this — callbacks arrive on port 80
# (a target's server-side fetch to http://<token>.oob.<host>/ uses the default http port).
ENV PORT=8080
WORKDIR /app/apps/oob-listener

# Copy the built workspace wholesale. pnpm's node_modules is a symlink farm rooted at /app; keeping the
# same absolute path preserves those links, so @corvid/* and third-party deps resolve at runtime.
COPY --from=build /app /app

# Unprivileged user — we bind 8080 in-container (not a privileged port); the host maps :80 → :8080.
USER node
EXPOSE 8080

# Boot validates env fail-closed (§9): a missing safety-relevant var exits non-zero, never a
# half-started listener. Restart policy (compose/systemd) turns that into a crash loop until fixed.
CMD ["node", "dist/server.js"]
