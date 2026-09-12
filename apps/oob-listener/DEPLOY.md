# Deploying the OOB callback listener

This is the last piece the fifth vuln class — **blind SSRF (D-16 / ADR-09)** — needs. The code is
built, unit-tested, and container-validated; SSRF stays disabled (hypotheses skipped, never sent) until
this listener is reachable and the gateway is pointed at it. Deploying it doesn't touch the other four
classes.

**Path-token scheme (ADR-36):** the listener serves on **one public host** and a callback is
`<base>/<token>` — **no wildcard DNS and no domain required**. That makes the fastest path a free
**ngrok** tunnel to a local Docker container.

## What it does (why it needs to be public)

The callback doesn't come from us — it comes from the **target's own server**. The target's server-side
fetch has to reach the listener over the public internet, so the listener must be publicly reachable.
One Hono process, two roles told apart by the URL path (`src/capture.ts`):

- **Control plane** — `POST /register` mints a token, `GET /callbacks/:token` reads one.
  Bearer-authenticated (`OOB_CONTROL_TOKEN`). The only caller is the E2B sandbox burst, which registers a
  token before injecting the payload. (The gateway reads verdicts straight from the shared Redis ledger,
  not over HTTP.)
- **Callback capture** — a token-shaped first path segment (`<base>/<token>`) is a callback: the target's
  server-side fetch reached us. Recorded (correlated to the token, with source IP + time) and answered
  with a constant benign `200`, so probers get no oracle.

## Prerequisites

- Docker (to run the listener) — or Node ≥24 + pnpm 11 to run it bare.
- The **shared** managed Postgres and Redis the gateway already uses (same `DATABASE_URL` / `REDIS_URL`).
  The schema must already be migrated by the main app — this listener never runs migrations.
- One way to expose a local port publicly: **ngrok** (fastest, free) — or a public box / PaaS.

---

## Fast path — ngrok + local Docker (no domain, ~10 min)

### 1. Build the image (from the repo root — the build context is the whole workspace)

```sh
docker build -f apps/oob-listener/Dockerfile -t corvid-oob-listener .
```

### 2. Start ngrok pointing at the container's port

Install ngrok, authenticate once (`ngrok config add-authtoken <token>`), then:

```sh
ngrok http 8080
```

Copy the forwarding host it prints, e.g. `https://a1b2c3d4.ngrok-free.app` → host `a1b2c3d4.ngrok-free.app`.

### 3. Fill the listener env (`apps/oob-listener/.env`, see `.env.example`)

| Var                 | Value                                          |
|---------------------|------------------------------------------------|
| `OOB_HOST`          | `a1b2c3d4.ngrok-free.app` (bare host)          |
| `OOB_PUBLIC_BASE`   | `https://a1b2c3d4.ngrok-free.app`              |
| `DATABASE_URL`      | the shared managed Postgres                    |
| `REDIS_URL`         | the shared managed Redis                       |
| `OOB_CONTROL_TOKEN` | a secret — `openssl rand -hex 32`              |

### 4. Run the listener, mapping the port ngrok points at

```sh
docker run -d --name corvid-oob --restart unless-stopped \
  -p 8080:8080 --env-file apps/oob-listener/.env corvid-oob-listener
docker logs corvid-oob     # → {"...":"oob-listener listening","publicBase":"https://a1b2c3d4.ngrok-free.app"}
```

### 5. Point the gateway at it and restart it

Add to the gateway's env (same `OOB_CONTROL_TOKEN` value as the listener):

| Var                     | Value                                                   |
|-------------------------|---------------------------------------------------------|
| `OOB_HOST`              | `a1b2c3d4.ngrok-free.app` (added to the sandbox egress allow-list) |
| `OOB_REGISTER_URL`      | `https://a1b2c3d4.ngrok-free.app/register`              |
| `OOB_CONTROL_TOKEN`     | the **same** secret as the listener                     |
| `REDIS_URL`             | the **same** shared Redis (already set)                 |
| `OOB_TIMEOUT_MS`        | optional, default `300000` (the D-4 5-min wait bound)   |
| `OOB_SWEEP_INTERVAL_MS` | optional, default `60000`                               |

SSRF turns on only when the gateway sees **all three** `OOB_*` vars **and** a shared `REDIS_URL`
(all-or-nothing). Missing any → SSRF is skipped and nothing hangs.

> ngrok note: each free-tunnel restart gives a **new** host — update all four values (listener
> `OOB_HOST`/`OOB_PUBLIC_BASE`, gateway `OOB_HOST`/`OOB_REGISTER_URL`) and restart both if you restart
> ngrok. A reserved domain (paid) or Cloudflare Tunnel keeps it stable.

### 6. Confirm blind SSRF on the testbed

With the listener up and the gateway restarted:

```sh
node scripts/drive-scan.mjs
```

Approve the SSRF hypothesis at the gate. The burst (inside E2B) registers a token via `OOB_REGISTER_URL`,
injects `https://<host>/<token>` into `POST /api/import`, and the testbed's server-side fetch hits the
listener. The run pauses at the durable `awaitOob` interrupt; within `OOB_TIMEOUT_MS` the in-gateway
sweep resumes it, the deterministic gate reads the correlated callback from Redis, and mints the SSRF
finding. No callback → `not_confirmed` (the safe default), never a socket guess. Read it back from the
owner-scoped `/findings` (or the stored report). Watch it land:

```sh
docker logs -f corvid-oob    # the callback records the token; an audit row lands in shared Postgres
```

---

## Alternative — your own box or PaaS

Same image, just a different public entrypoint (no wildcard needed anymore):

- **A box:** run `-p 80:8080`, set `OOB_HOST=oob.example.com`, `OOB_PUBLIC_BASE=http://oob.example.com`
  (or put TLS in front and use `https://`), and point a single `A oob → BOX_IP` record at it. Gateway
  `OOB_REGISTER_URL=http://oob.example.com/register`.
- **Render/Fly free web service:** deploy the image; use the app URL as both `OOB_HOST` (bare) and
  `OOB_PUBLIC_BASE` (`https://…`). The sandbox's register call warms a cold instance *before* the target
  callback fires, so free-tier spin-down isn't a problem.

## Smoke tests (Redis-free — bearer gate + routing)

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8080/register -d '{}'  # → 401
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/not-a-token               # → 404
```

The callback-capture and valid-`/register` paths write the shared Redis ledger, so they're exercised by
`test/app.test.ts` and by the live run in step 6.

## Notes

- **Single instance.** The in-gateway sweep has no cross-replica lock yet (ADR-35 deferred a standalone
  worker). Run one gateway instance while SSRF is enabled.
- **Image size.** The runtime stage copies the whole built workspace (dev deps included) to preserve
  pnpm's symlink farm — fine for one internal box. Trim later with a `pnpm deploy --prod` stage if needed.

## Bare Node (no Docker)

```sh
pnpm install --frozen-lockfile
pnpm --filter @corvid/oob-listener... build
OOB_HOST=a1b2c3d4.ngrok-free.app OOB_PUBLIC_BASE=https://a1b2c3d4.ngrok-free.app PORT=8080 \
  DATABASE_URL=… REDIS_URL=… OOB_CONTROL_TOKEN=… node apps/oob-listener/dist/server.js
```
