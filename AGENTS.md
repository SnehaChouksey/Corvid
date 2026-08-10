# AGENTS.md

**Corvid** — autonomous AppSec agent: authorize a target → crawl (passive) →
LLM hypothesizes candidate vulns → human approves each active test → tools send
payloads in a sandbox → a **deterministic, non-LLM check** verifies the exploit
fired → report **verified findings only**. Zero unverified findings is the whole
product.

Stack: **all TypeScript, one monorepo (pnpm workspaces + Turborepo, ADR-18)** ·
Next.js + shadcn/ui (dashboard) · Better Auth (platform auth, single-user
tenancy, ADR-19) · Hono (thin API gateway) · LangGraph.js (agent reasoning +
**durable scan runtime via Postgres checkpointer, ADR-27 — no Temporal**) · MCP
(tool servers) · Playwright (crawl) · OpenRouter (LLM gateway, ADR-23) ·
PostgreSQL · Redis (dedup/frontier + BullMQ job queue + pub/sub finding fan-out,
ADR-17) · E2B (per-testing-burst egress-restricted sandbox, ADR-22) ·
self-hosted OOB callback listener. Hosting: E2B + managed free tiers (Postgres,
Redis) + a small box for the OOB listener (ADR-D9).

**Status: spec v1, pre-code.** No implementation exists yet. `00`–`05` +
`CODING_STANDARDS.md` are the plan; `docs/progress-tracker.md` starts empty and
fills as units are built.

## Read first
1. `docs/progress-tracker.md` — current unit status, what's actually done
2. Routing table below
3. `docs/specs/04_design_decisions_log.md` — don't re-decide a settled ADR; open items live in `03` §10

## Docs
Numbered specs live in `docs/specs/`; routing shorthand `00`–`05` below means those files.
| Doc | For |
|---|---|
| `docs/specs/00_project_overview.md` | What/why, scope, vuln classes, principles, risks |
| `docs/specs/01_product_ux_flow_spec.md` | Every analyst screen, flow, and edge state |
| `docs/specs/02_system_architecture_spec.md` | Implementation reference — components, sequence/DFDs, data model, tool contracts, security |
| `docs/specs/03_build_plan.md` | Units 0–8, dependency graph, open-decision register (§10) |
| `docs/specs/04_design_decisions_log.md` | ADR history — why it's like this |
| `docs/specs/05_future_improvements_v2.md` | Deliberately deferred — don't build early |
| `docs/CODING_STANDARDS.md` | Code conventions + safety/verification invariants |
| `docs/progress-tracker.md` | Execution log |

## Routing
| Task | Section |
|---|---|
| Scan lifecycle, durability, pause/resume, OOB-timeout sweep | `02` §1, §3, §8 · `04` ADR-27 (LangGraph checkpointer; ADR-07 ⛔ Temporal removed) |
| Agent reasoning loop, hypothesis generation | `02` §1 · `03` Unit 3 · `04` ADR-10 |
| MCP tool servers / contracts (crawler, http.send, jwt, ssrf, injection, idor) | `02` §10 · `03` Unit 4 · `04` ADR-11 |
| **Verification gate (deterministic, non-LLM)** | `02` §4.4 · `03` Unit 5 · `04` ADR-01 · `CODING_STANDARDS.md` §3, §5 |
| OOB callback listener / blind-SSRF proof | `02` §3.2, §4.4 · `04` ADR-09 |
| Human approval gate | `01` §6 · `02` §3.3 · `04` ADR-02 |
| Platform auth & tenant isolation (Better Auth) | `02` §5, §6, §7 · `04` ADR-19 · `CODING_STANDARDS.md` §5 |
| Authorization, scope recording & proof-of-control | `01` §3 · `02` §7 · `04` ADR-03, ADR-D7 |
| Platform abuse controls (API rate limit, concurrent-scan cap) | `02` §7 · `04` ADR-20 · `03` §10 D-11 |
| LLM spend cap / kill-switch | `02` §7, §8 · `04` ADR-21 · `03` §10 D-12 |
| Sandbox (E2B) + egress allow-list + lifecycle | `02` §7, §8, §9, §11 · `04` ADR-08, ADR-22 · `03` §10 D-9 |
| LLM gateway (OpenRouter) + model selection | `02` §3.2 · `04` ADR-23 · ties to ADR-21 |
| Verification signals per class (JWT/injection/IDOR/SSRF) | `02` §4.4 · `04` ADR-D13–D16 · `03` §10 D-13–D-16 |
| Target credentials (crawl/JWT/IDOR), scope granularity | `01` §4 · `02` §7, §10 · `04` ADR-D1, ADR-24 |
| Finding fan-out (BullMQ + Redis pub/sub) / reporting (verified-only) | `02` §1, §8 · `03` Unit 7 · `04` ADR-05, ADR-17 |
| DB schema / lifecycle state machine | `02` §5, §5.1 |
| REST API surface | `02` §6 |
| Audit log | `02` §4.2, §7 · `04` ADR-16 |
| Dashboard behavior, screens, empty/error states | `01` (whole), §11–12 · `CODING_STANDARDS.md` §10 |
| "Should I build X?" | `05` first · `00` §6 non-goals |
| "Was this decided already?" | `04` first · open items in `03` §10 |
| "What's next?" | `03` §9 + `docs/progress-tracker.md` |
| Any code | `CODING_STANDARDS.md` |

## Non-negotiables
- **Verify, never guess.** A finding is reported only after a deterministic,
  non-LLM check proves the exploit fired. The verification gate never imports an
  LLM client (`00` §7.1 · `02` §4.4 · ADR-01)
- **No active payload without recorded authorization AND human approval.**
  Enforced at two layers (workflow + sandbox egress), computed from one scope
  (`02` §7 · ADR-02/03/08)
- **Sandbox egress is allow-listed to target + OOB listener only**, at the E2B
  firewall (`denyOut: all` + `allowOut: [target, OOB]`, ADR-08/22); the agent core
  never touches the network directly — all target traffic flows through a tool
  server. Egress is host-level; path scope is enforced in `http.send` (ADR-24).
  Never read a socket/connect success as reachability — verify by app-level/OOB
  signal only (E2B can accept-then-drop a denied egress)
- **The report contains verified findings only** — the report writer has no path
  to raw agent reasoning (`00` §7.1 · ADR-05)
- **Every request is authenticated and owner-scoped** — no cross-tenant read
  path; a not-owned resource is a 404, not a 403 (ADR-19 · `CODING_STANDARDS.md` §5)
- **Authorization needs proof-of-control**, not a self-asserted checkbox — the
  control that stops a user aiming Corvid at a target they don't own (D-7/ADR-D7)
- **Platform abuse controls fail closed** — per-user API rate limits + concurrent
  -scan cap (ADR-20); a refusal is a typed outcome, never a 500 or silent drop
- **LLM spend is recorded at the call site and daily-capped** (global + per-user,
  ADR-21); the kill-switch degrades reasoning only, never the verification gate
- **"Not confirmed" is a domain outcome, never an exception; a tooling error is
  never a clean negative** (`CODING_STANDARDS.md` §4)
- **Everything is audited** — every action, actor, timestamp, at the point it
  happens; append-only; a path that skips it is a defect (ADR-16)
- **Secrets and raw target response bodies never reach a log line** —
  structurally, not by vigilance (`CODING_STANDARDS.md` §5)
- **Tool contracts are additive-only; a tool never decides "verified"** — it
  emits observations, the gate decides (`02` §10 · `CODING_STANDARDS.md` §8)
- **Fail closed on anything safety-relevant** — an unset egress/authorization
  config fails the boot, never defaults to open (`CODING_STANDARDS.md` §9)

## When done
Update `docs/progress-tracker.md`. Resolving a D-## is four writes: log entry
there, its ADR in `04` updated with the resolution, `03` §10 row flipped,
source-doc [Assumption] updated. Any new judgment call that changes what the
software *is* → new ADR in `04` first (plus a D-## row in `03` §10 if it stays
open), never a silent default. Don't build `05`'s deferred items early — each
names the observed trigger that promotes it, and nothing may weaken the two
launch invariants. Per `CODING_STANDARDS.md` §12: install dependencies via the
package manager's command, never a hand-typed version; verify against official
docs before coding against an external library (MCP spec, LangGraph.js, E2B,
Playwright all move fast — LangGraph's TS SDK especially, since it now owns
durability, ADR-27); run a security & safety review at the end of every
unit and fix findings before dependent units build on it.

## The two invariants that gate every "Done"
A unit is not done — no matter how complete the feature — while either can be
violated:
1. No code path sends an active payload outside recorded authorization.
2. No unverified finding can reach a report.

## Repo & tooling (ADR-18)
**All TypeScript, one monorepo — pnpm workspaces + Turborepo.** `apps/*` for
deployables (dashboard, gateway, agent core, each tool server, OOB listener,
scan-runtime worker), `packages/*` for shared code — the MCP tool contracts/schemas
package first among them. Add deps with `pnpm --filter <pkg> add …`, never a
hand-typed version, scoped to the narrowest workspace that needs it. No code
exists yet; once scaffolded, the standard gates are
`pnpm turbo run typecheck lint test build`. LangGraph's TS SDK is younger than
its Python one — verify against its current docs before coding, and surface a
capability gap rather than working around it.

<!-- Added: 2026-08-10 -->
## Schema validation & MCP SDK
Use **Zod v4** (`zod@^4`) as the single schema-validation library across the monorepo (env, LLM output, MCP tool args/results, HTTP responses, OOB payloads, REST bodies — CODING_STANDARDS §1). Build MCP tool servers against the **v2 SDK line** (`@modelcontextprotocol/server` / `client`), which uses Zod ≥4.2 internally (not a peer dep) — so there is exactly one Zod major in the repo and no dual-copy type collision. Do NOT mix in the v1 `@modelcontextprotocol/sdk` (it peer-depends on `zod ^3.25 || ^4.0` and has a known duplicate-copy footgun). Author tool input schemas as `z.object({...})`, not a raw shape. Zod v4 error formatting: `z.prettifyError` / `z.treeifyError` (`.format()`/`z.formatError` are deprecated).

## Structured logging
Use **Pino v10** via the shared `@corvid/logger` package (`import pino from 'pino'` — default import, needs `esModuleInterop`). Never `console.*` in product code (enforced by an ESLint `no-console` rule). Pino `redact` operates on **object property paths only — it never scrubs the message string**. Therefore product code must pass secrets/raw bodies as structured fields (covered by redact paths), never interpolated into the free-text message (CODING_STANDARDS §5, §13).
