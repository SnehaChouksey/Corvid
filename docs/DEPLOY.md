# Corvid — deployment runbook

Deploys the system as `02` §9 planned: dashboard on a serverless front end, the backend as long-lived
services, data on managed tiers, sandboxes on E2B. This is **single-operator** (single-user tenancy,
ADR-19) — not an open public SaaS.

> **Honest scope.** This is a real multi-service deploy with third-party accounts, secrets, and a couple
> of integration items that need iteration (cross-site auth cookies especially). It is **not** a
> one-click or a single-afternoon task, and it isn't free (see Cost). Nothing here can be done without
> your accounts + secrets.

## 1. Topology — where each piece runs and why

| Component | Host | Why there |
|---|---|---|
| Dashboard (Next.js) | **Vercel** | Serverless front end — Vercel's core use case |
| API gateway (REST + durable scan runtime + OOB sweep + crawler subprocess) | **Render web service (Docker)** | Long-lived, stateful, spawns Chromium — cannot be serverless |
| Report worker (queue → report → PDF) | **Render background worker (Docker)** | Continuous BullMQ consumer, renders PDF with Chromium |
| OOB listener (blind-SSRF callbacks) | **Render web service (Docker)** | Persistent public inbound (ADR-36 single-host) |
| Postgres | **Neon** (managed free/paid) | Durability rides Postgres (LangGraph checkpointer, ADR-27) |
| Redis | **Upstash** (managed) | Frontier/dedup + BullMQ queue + OOB ledger (ADR-17) |
| Sandboxes | **E2B** | Egress-restricted microVMs for the testing burst (ADR-22) |
| LLM | **OpenRouter** | Reasoning gateway (ADR-23) |

The three backend services are described as Infrastructure-as-Code in `render.yaml`. Their Dockerfiles
are `apps/{gateway,report-worker,oob-listener}/Dockerfile`.

## 2. Cost reality (read before you start)

Avinash's plan said "free app tier," but the workload has outgrown a pure free tier:

- The **gateway** spawns Chromium and runs a scan burst — Render's **free** web tier (512 MB, spins down
  after 15 min idle) will likely OOM or cold-start mid-scan. Use at least **Starter (~$7/mo)**.
- A Render **Background Worker has no free tier** — the report worker needs a paid instance (~$7/mo).
- **Neon** and **Upstash** have usable free tiers for a demo; **E2B** and **OpenRouter** run on
  credits/pay-as-you-go (a scan measured ≈ 0.0023 credits, so LLM cost is negligible; E2B sandbox time
  is the real variable).

Realistic minimum for a *reliable* always-on demo: **~$14/mo** (gateway + worker on Starter), plus
E2B/OpenRouter usage. A throwaway demo can run the gateway on free and skip the worker (no PDF/report),
accepting spin-down.

## 3. Secrets to generate up front

```sh
openssl rand -hex 32      # BETTER_AUTH_SECRET
openssl rand -base64 32   # ENCRYPTION_KEY (32-byte AES-256, D-1)
openssl rand -hex 32      # OOB_CONTROL_TOKEN (only if deploying SSRF)
```

Plus API keys you already hold or must create: **OPENROUTER_API_KEY**, **E2B_API_KEY**. Never commit
these; they go in each platform's secret store.

## 4. Order of operations

### 4.1 Data tiers
1. Create a **Neon** project → copy the pooled connection string → `DATABASE_URL`.
2. Create an **Upstash** Redis DB → copy the `rediss://…` URL → `REDIS_URL` (shared by gateway, worker,
   and OOB listener — it must be the *same* instance).

### 4.2 Migrate the schema (once, before the services boot)
The services never run migrations. From your machine, against the Neon URL:
```sh
DATABASE_URL='postgresql://…neon…' pnpm --filter @corvid/db migrate   # see packages/db for the exact script
```
Confirm the tables exist (targets, scans, hypotheses, findings, audit_log, llm_calls, reports, Better
Auth tables) before continuing.

### 4.3 Backend on Render (blueprint)
1. Render → **New → Blueprint** → select this repo (`avinash-1707/Corvid`, or your fork) → it reads
   `render.yaml` and proposes the three services.
2. Fill every `sync: false` var in the dashboard. For `corvid-gateway` set `BETTER_AUTH_URL` to its own
   public URL (e.g. `https://corvid-gateway.onrender.com`) after the first deploy assigns it.
3. Leave the `OOB_*` vars unset for now unless you're doing SSRF (§4.6).
4. Deploy. Watch logs for `gateway listening`; hit `https://…onrender.com/health` → `{"status":"ok"}`.

### 4.4 Dashboard on Vercel
1. Vercel → **New Project** → this repo → **Root Directory = `apps/dashboard`**. It's a monorepo, so set
   the install/build to run from the repo root (Vercel detects pnpm workspaces; if not, install command
   `pnpm install` at root and build `pnpm --filter @corvid/dashboard build`).
2. Set `NEXT_PUBLIC_API_URL` (see §5 — this is the crux) and deploy.
3. Put the dashboard's final origin into the gateway's `TRUSTED_ORIGINS` and redeploy the gateway.

### 4.5 Lock sign-up to you (single operator)
This is an offensive tool — do **not** leave open registration. Create your one account, then disable new
sign-ups. Better Auth exposes this (`emailAndPassword.disableSignUp` / a `before` hook on the sign-up
route); I can wire a `SIGNUP_ENABLED=false` env gate in `@corvid/auth` when you're ready — it's a small
change, not yet made.

### 4.6 OOB listener (only for the 5th class, SSRF)
Deploy `corvid-oob-listener` from the blueprint; set `OOB_HOST`/`OOB_PUBLIC_BASE` to its Render URL and a
shared `OOB_CONTROL_TOKEN`. Then set the gateway's `OOB_HOST` / `OOB_REGISTER_URL` /`OOB_CONTROL_TOKEN`
to match and redeploy. Full detail in `apps/oob-listener/DEPLOY.md`.

## 5. The one hard integration item — cross-site auth cookies

The dashboard (`*.vercel.app`) and gateway (`*.onrender.com`) are **different registrable domains**, i.e.
*cross-site*. Better Auth session cookies default to `SameSite=Lax`, which browsers will **not** send on a
cross-site request — so a naive split means **login appears to succeed but the session never sticks**.
Two ways to solve it:

- **Recommended — one custom domain (needs a domain, ~$10/yr):** put the dashboard on
  `app.yourdomain.com` (Vercel) and the gateway on `api.yourdomain.com` (Render). Same parent domain →
  set the auth cookie `Domain=.yourdomain.com` with `SameSite=Lax` and it works. This needs a small
  `@corvid/auth` cookie-config change (`crossSubDomainCookies` / cookie domain) — tell me the domain and
  I'll wire it. Set `NEXT_PUBLIC_API_URL=https://api.yourdomain.com`.
- **No-domain alternative — same-origin proxy:** add Next.js `rewrites()` in the dashboard so
  `/api/*` proxies to the gateway, and set `NEXT_PUBLIC_API_URL` to the dashboard's own origin. The
  browser then only ever talks to the Vercel origin (same-site), so cookies work with no CORS. This is a
  dashboard-only change (a `next.config` rewrite) — I can add it, but it needs a live round-trip to
  confirm Better Auth's redirect/origin handling behaves through the proxy.

Until one of these is in place, expect the deployed login to fail even though every service is "up." This
is the item most likely to need a live iteration pass.

## 6. Verify end to end

1. Sign in on the dashboard; confirm the session persists across a refresh (proves §5).
2. Add a target, complete D-7 proof-of-control, start a scan.
3. Approve a hypothesis → the burst runs in E2B → a verified finding appears → the report generates
   (proves the worker + queue).
4. If SSRF is enabled, confirm a callback lands (`docker logs`/Render logs on the OOB service).

## 7. What I can do vs. what only you can do

- **Me:** the Dockerfiles (done + being validated), `render.yaml`, this runbook, the `/health` route, the
  sign-up lock, the auth cookie change, and the Next.js proxy — all code/config in the repo.
- **You:** create the Render/Vercel/Neon/Upstash accounts, hold and paste the secrets, run the migration,
  click deploy, and buy a domain if you take the recommended cookie path. I can't authenticate to those
  platforms or hold your secrets.
