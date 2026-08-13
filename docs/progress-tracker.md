# Corvid — Progress Tracker

**Progress tracker** · Companion docs: [`specs/00_project_overview.md`](specs/00_project_overview.md), [`specs/01_product_ux_flow_spec.md`](specs/01_product_ux_flow_spec.md), [`specs/02_system_architecture_spec.md`](specs/02_system_architecture_spec.md), [`specs/03_build_plan.md`](specs/03_build_plan.md), [`specs/04_design_decisions_log.md`](specs/04_design_decisions_log.md), [`specs/05_future_improvements_v2.md`](specs/05_future_improvements_v2.md), [`CODING_STANDARDS.md`](CODING_STANDARDS.md)
**Status:** Live document — updated as execution happens
**Source of truth for:** what has actually been built, unit by unit, and any real-world deviations from the specs discovered along the way.

---

## 0. How to use this file

This tracks **execution** — progress against the build plan, decision resolutions, and deviations. It's the companion to the other documents, and the boundary matters so entries land in the right place:

- **`specs/04_design_decisions_log.md`** is the historical record of decisions and their reasoning. If an entry here represents a genuine *new* decision (not just an update on progress), it needs a new ADR there too — this file references it, never duplicates its reasoning.
- **`specs/03_build_plan.md`** defines the units, their dependencies, and the register of open decisions (§10). This file tracks progress *against* that plan; it doesn't redefine the units. When work here resolves a D-## decision, four writes happen together: a log entry below, its ADR in `specs/04` updated with what was decided, the §10 row in `03` flipped to **Resolved**, and the originating spec doc's [Assumption] marker updated. The specs must never silently disagree with what was built.

Every entry in the log (§3) should answer: what happened, does it match the spec or deviate, and if it deviates, which ADR (existing or newly added) covers it.

**Two invariants gate every "Done" in this project** (`03` §0): no code path may send an active payload outside recorded authorization, and no unverified finding may reach a report. A unit is not Done while either can be violated, regardless of feature completeness.

---

## 1. Unit status at a glance

Nothing is built yet — this is spec v1, pre-code. The planning stage is fully recorded in `00`–`05` and `CODING_STANDARDS.md`; execution starts when the first unit does.

| Unit | Status | Last updated | Notes |
|---|---|---|---|
| Unit 0 — Authorization, Targets & Environment Prerequisites | Not started | 2026-08-10 | External lead time: real authorized target, practice labs, OOB domain + wildcard DNS. Provision E2B (ADR-22), OpenRouter (ADR-23), managed Postgres/Redis (durability via LangGraph checkpointer, no Temporal — ADR-27/ADR-D9) |
| Unit 1 — Foundation | In progress (items pending external) | 2026-08-10 | Owns D-11 (D-9 resolved). **Safety spine built & tested vs real Postgres:** scaffold + shared configs; `@corvid/db` (02 §5 schema, owner-scoped repos, structurally-immutable audit via triggers, ADR-16); `@corvid/scope` (one-scope authz+egress, SSRF-host reject, §3/ADR-24); `@corvid/auth` (Better Auth + tenant identity, ADR-19); `@corvid/scan-runtime` (durable LangGraph + Postgres checkpointer, restart-mid-pause proven, ADR-27); `@corvid/sandbox` (two-layer authz + egress allow-list, ADR-22); `apps/gateway` (Hono: auth, 404-not-403, per-user + auth-surface rate limits, atomic concurrent-scan cap, ADR-20). DB-layer = Drizzle (ADR-28). **Pending external (Unit 0):** live E2B egress-denial proof needs `E2B_API_KEY`; managed Postgres/Redis for deploy. **Deferred follow-ups:** Redis-backed rate store (Unit 2), audit-on-refusal wiring, resume-value validation (Unit 6), REVOKE+non-owner DB role. D-11 limit values still config defaults |
| Unit 2 — Crawler & Attack-Surface Mapping | In progress (safety spine done; pending external + hardening) | 2026-08-11 | `crawler.map` MCP tool (v2 SDK, stdio) built: `@corvid/tool-contracts` crawler contract; `@corvid/redis` (ioredis frontier+dedup, proven vs real Redis); `apps/crawler` Playwright engine — SPA-aware, endpoints/params/auth-flow map. **No-out-of-scope-request property PROVEN end-to-end** vs real Chromium (fetch/img/xhr/link/popup/WebSocket to an out-of-scope host all aborted at the browser). Scope+seed+authorization read from the DB target row, not tool args (C1). Redis rate-limit store migration folded in (proven vs real Redis). New: **ADR-29/D-17** (crawler egress risk acceptance). **Pending external (Unit 0):** map-completeness sign-off on a real seeded target; managed Redis deploy. **Hardening follow-ups:** M4 (frontier TTL refresh mid-crawl), M5 (frontier fail-closed on Redis pipeline error), M8 (overall wall-clock crawl deadline) **done (2026-08-11)**; remaining: resolve-and-pin private-IP reject (D-17/M2, gated on a non-lab real target) |
| Unit 3 — Agent Core (perceive → hypothesize → plan) | Done (items pending external) | 2026-08-12 | Owns D-10 (resolved), D-12 (mechanism+defaults built; values in Unit 8). Built in 7 committed slabs: `@corvid/llm` (OpenRouter client + cost metadata + stub, ADR-23; only LLM importer, ADR-01); `llm_calls` spend ledger + daily kill-switch (ADR-21); hypothesis contract + fingerprint (ADR-D10); replay-safe upsert dedup + `@corvid/redis` `HypothesisDedup` (ADR-27); `@corvid/agent-core` perceive/hypothesize/plan nodes (DI, unit-tested with a stub LLM); wired into the durable `@corvid/scan-runtime` graph. **Security review passed.** New ADR-30 (`hypotheses.plan` jsonb) + ADR-31 (`stopped` state). **Pending external (Unit 0):** a live OpenRouter run needs the API key (built + tested offline with a fake client). Deferred review items #3/#4 documented |
| Unit 4 — MCP Tool Servers (the testers) | In progress (built & offline-tested; live pending external) | 2026-08-13 | Owns D-2 (mechanism built). **All tools built + fixture-tested offline:** `@corvid/http-send` (the single choke point — authz→path-scope(ADR-24)→dedup(check-before/mark-after, replay-safe)→rate posture+adaptive backoff(D-2)→audit; a payload can't bypass it) and `@corvid/testers` (`jwt.mutate_test` real alg:none/HS-RS/key-reuse forgeries + D-13 three-way; `injection.fuzz` SQLi error+dose-response time+NoSQLi, D-14; `ssrf.check` OOB token, D-16; `idor.compare` two-session, D-15). Every tool sends only via `http.send` and emits observations — never a verdict (§8). Security review passed (dropped-payload + injection-baseline/location fixes). **Pending external (Unit 0):** live send needs `E2B_API_KEY` + a practice lab. **Deferred (additive):** boolean-differential injection signal, path-param + non-JSON-body injection, `isUrlInScope` dangerous-host/port defense-in-depth (recommend to @corvid/scope owner). Analyst creds (D-1) captured in Unit 6 |
| Unit 5 — Verification Engine & OOB Listener | Not started | 2026-08-10 | Owns D-4, D-13–D-16 (the per-class verification signals). The linchpin — narrow end-to-end slice proven here first |
| Unit 6 — Human Approval Gate & Dashboard | Not started | 2026-08-10 | Owns D-7 (incl. proof-of-control). Dashboard + approval signal + scan-config credential capture (D-1) |
| Unit 7 — Finding Fan-out & Reporting | Not started | 2026-08-10 | Owns D-3. Redis BullMQ jobs + pub/sub fan-out (ADR-17) + verified-only report writer |
| Unit 8 — Hardening & Validation | Not started | 2026-08-10 | Precision/recall, one real finding, whole-system safety audit |

Update the **Status** column as work happens: `Not started` → `In progress` → `Done` (append `(items pending external)` when a DoD line waits on something outside our control, e.g. a real authorized target's provisioning). Keep **Last updated** current — a stale date here is worse than no table at all.

---

## 2. Decision resolutions at a glance

Mirror of `03` §10's Status column, kept here so a reader of this file alone can see what's been decided. One line per resolved decision, newest first; full reasoning lives in the log entry it points to.

**Resolved during planning (2026-08-10) — every specs-level decision is now closed:**
- **D-1** → target credentials analyst-supplied at scan config, encrypted, target-scoped (ADR-D1).
- **D-2** → conservative default rate + adaptive backoff on 429/403/WAF in `http.send`, analyst-overridable (ADR-D2).
- **D-3** → CVSS 3.1 base score + vector per finding (ADR-D3).
- **D-4** → 5-min OOB wait via the timeout sweep; late callback = audit note only (ADR-D4).
- **D-7** → DNS TXT or `/.well-known/` proof-of-control, Corvid-verified before authorize (ADR-D7).
- **D-9** → E2B sandboxes + managed Postgres/Redis; **durability via LangGraph Postgres checkpointer, Temporal removed** (ADR-27/ADR-D9); small OOB box.
- **D-10** → fingerprint `hash(vuln_class + normalized method+path + param + payload family)` (ADR-D10).
- **D-13–D-16** → per-class verification signal *methods* resolved (ADR-D13–D16); numeric thresholds calibrated on the labs in Unit 5.
- New/confirmed ADRs: **ADR-18** (all-TS monorepo), **ADR-19/20/21** (auth+tenancy / abuse controls / LLM spend), **ADR-22** (E2B sandbox), **ADR-23** (OpenRouter), **ADR-24** (host egress + path scope), **ADR-25** (sequential testing v1), **ADR-26** (report = dashboard + JSON + PDF), **ADR-27** (LangGraph durable checkpointer owns lifecycle; **ADR-07 Temporal superseded/removed**).

**Deliberately left open — values, not decisions:** **D-11** (abuse-limit numbers, Unit 1) and **D-12** (LLM spend ceilings, Unit 3) ship as conservative config defaults, raised on real usage/cost; and the numeric *thresholds* inside D-13–D-16, calibrated against the practice labs in Unit 5. A threshold is a measurement, not a paper value.

**Added during build (post-planning):** ADR-28 (Drizzle, Unit 1); ADR-29 / D-17 (crawler egress risk acceptance, Unit 2); **ADR-30** (`hypotheses.plan` jsonb) and **ADR-31** (`stopped` lifecycle state) (Unit 3). D-12's spend mechanism + conservative defaults (global 5 / user 1 credits/day) are now built; the numeric ceilings are still raised in Unit 8.

---

## 3. Log

Execution log starts when building starts (Unit 0 counts — securing a real authorized target and standing up practice labs is execution). The planning stage is fully recorded elsewhere: scope in `00`–`01`, architecture and assumptions in `02`, standards in `CODING_STANDARDS.md`, sequencing and open decisions in `03`, reasoning in `04` — nothing from that stage needs to live here.

### Entry template
Copy this for every new entry. Keep entries newest-first below the template.

```
### [YYYY-MM-DD] Short title
**Unit:** which unit this belongs to
**Type:** Progress update | Decision resolved | Deviation from spec | Gap found | External status change
**Summary:** what happened, in a few sentences
**Files/areas touched:** rough pointer, not a full diff (or "None — external" for Unit 0 items)
**Related decision:** ADR-## / D-## if this resolves or changes a logged decision
  (say what it was resolved TO, and confirm the ADR in `specs/04`, the `03` §10 row,
  and the source-doc [Assumption] were all updated); "New — added ADR-## to `specs/04`"
  if this entry introduced one; "None" if it's pure progress with no decision content
**Safety check:** confirm the two launch invariants still hold (no unauthorized payload
  path, no unverified finding path) — or state which is not yet applicable
**Follow-ups:** anything this opens up or blocks, if relevant
```

---

### [2026-08-11] Unit 2 hardening: frontier TTL refresh, fail-closed pipeline, crawl deadline
**Unit:** Unit 2 — Crawler & Attack-Surface Mapping
**Type:** Progress update
**Summary:** Closed three non-blocking hardening follow-ups from the crawler build:
- **M4 (frontier TTL refresh):** `CrawlFrontier.dequeue` now refreshes both the frontier and dedup keys' TTL on every active pop. Before, only an enqueue that added new URLs reset the TTL, so a long crawl that stopped discovering links could let its dedup/frontier state expire mid-crawl and lose the termination guarantee.
- **M5 (fail-closed on Redis pipeline error):** a `null` pipeline result (batch aborted) or a per-command error in any tuple now raises a retryable `InfraError` instead of the old silent `return 0`. A lost dedup or push pipeline no longer masquerades as "nothing new" — which for the seed would have made a crawl "complete" against an empty surface. `@corvid/redis` now depends on `@corvid/errors`.
- **M8 (wall-clock deadline):** `crawl` takes an optional `maxDurationMs` (default 15 min) and an injectable `now` clock; the loop stops before starting more work once past the deadline, even with page budget left — a backstop against hanging/slow pages. The completion audit records a `stopReason` (`drained` | `max_pages` | `deadline`) for accountability (ADR-16).
**Verification:** `pnpm turbo run typecheck lint test build` green (48 tasks). New always-on unit tests: three M5 fail-closed branches (null dedup result, errored dedup command, lost push pipeline) via a stub ioredis; two M8 tests (deadline stop with budget+frontier left; `max_pages` stopReason) via an injected clock; plus a `drained` stopReason assertion on the empty-surface test.
**Related decision:** None — pure hardening, no ADR change. D-17 (IP-level SSRF closure) remains open, gated on a non-lab real target.
**Safety check:** Both launch invariants unchanged. Invariant #1's crawler analogue (no out-of-scope request) still holds — these changes only bound runtime and fail closed on infra faults; none touches scope enforcement or introduces a payload path. Invariant #2 not applicable (no findings path yet).
**Follow-ups:** Remaining Unit 2 hardening is D-17/M2 (resolve-and-pin private-IP reject or crawl-in-sandbox) before a non-lab real target; M5's partial-pipeline case fails closed but isn't yet atomic (a URL SADD'd then RPUSH-lost stays marked seen) — a Lua-script atomic enqueue would close it fully if it proves to matter.

---

### [2026-08-13] Unit 4: MCP tester tools + the http.send choke point (built, offline-tested)
**Unit:** Unit 4 — MCP Tool Servers (the testers)
**Type:** Progress update + Decision confirmed (D-2 mechanism built)
**Summary:** Built all of Unit 4's tools as packages with pure logic + injected ports (unit-testable offline; live send deferred to E2B + a lab). Committed as slabs U4-1…U4-7 (`2703d33`, `8c7a32c`, `8d26e53`, `056c48a`, `99842f1`, `21c10d7`):
- `@corvid/tool-contracts` — `http.send` + the four tester contracts. Outputs are **observations** (a compact non-sensitive signal: status/byte-length/timing + a body **hash**, never the raw body — §5); no tool carries a "verified"/"vulnerable" field (§8).
- `@corvid/http-send` — the **single request choke point** every tester's traffic flows through (owner-approved as a shared library, so a payload structurally can't bypass it). Fixed order, each guard before any network I/O, every branch audited: authorization (fail-loud `AuthorizationError` — launch invariant #1, defense in depth) → path-level scope (`isUrlInScope`, ADR-24; out-of-scope-path refused + audited like a denied egress) → per-scan dedup (**check-before / mark-after**, so a send that throws re-tries on replay rather than being dropped — ADR-27) → rate posture (D-2: conservative min-delay + adaptive backoff on 429/403, gentle decay; sequential per scan, ADR-25) → send via an injected fetch → audit (method+origin+path only, §5). Dedup key includes canonical (injective) headers so JWT/IDOR's same-URL-different-auth requests don't collapse. `@corvid/redis` `HttpRequestDedup` fail-closed.
- `@corvid/testers` — `jwt.mutate_test` (pure, verifiable alg:none / HS-RS-confusion / key-reuse forgeries + the D-13 three-way none/valid/forged observation), `injection.fuzz` (SQLi error-based with a neutralized control + time-based dose-response + NoSQLi; reports matched DB-error pattern *names* only; refuses path/non-JSON-body params rather than mislocating — D-14), `ssrf.check` (registers a unique OOB token, injects `http://<token>.<oob-host>/`; confirmation is out-of-band, never a socket signal — D-16), `idor.compare` (same request under two analyst-supplied sessions at different privilege — D-15). Every tester sends **only** through `http.send` (given a `SendFn` port; it can't open its own socket) and emits an observation; the verifier (Unit 5) decides.
**Verification:** `pnpm turbo run typecheck lint test build` green (64 tasks). ~50 new tests across the tools (JWT forgery crypto, injection payload placement + error matching + dose-response, OOB token injection, two-session IDOR, and http.send's full enforcement chain incl. a thrown-send-is-re-sent-on-replay test). **Security & safety review** (3 finders, `789b737..99842f1`): invariants/§5/§8 clean (no verdict leak, no secret/body logged, no bypass of the authorization gate). Correctness fixes applied: dropped-payload dedup ordering (H1), injection benign-baseline + path/non-JSON refusal (M1–M3), byte-length signal (M4), injective dedup key (M5), gentle backoff decay (L1).
**Files/areas touched:** `packages/{tool-contracts,http-send,testers,redis}`.
**Related decision:** **D-2 mechanism built** (conservative rate + adaptive backoff in `http.send`; values config, tuned in Unit 8). No new ADR. **Structural note:** `http.send` is a shared library, not a separate MCP server (owner-approved) — the strongest form of "a payload never bypasses it."
**Safety check:** Launch invariant #1 (no active payload outside recorded authorization) is now enforced **structurally at the tool layer**: the only path to the network is `http.send.send()`, which refuses without recorded authorization and refuses out-of-scope paths, before any I/O. Invariant #2 (no unverified finding in a report): testers emit **observations only**, never a verdict or a finding — the deterministic gate is Unit 5. Residual: everything is fixture-tested; **no payload has hit a real target yet** (needs E2B + a lab, Unit 0).
**Follow-ups:** live tester run vs a seeded lab (Unit 0/8); Unit 5 verifier (the deterministic gate + OOB listener) consumes these observations; deferred additive items (boolean-differential injection, path/non-JSON-body injection, `isUrlInScope` hardening).

---

### [2026-08-12] Unit 3: agent core (perceive → hypothesize → plan), built end to end
**Unit:** Unit 3 — Agent Core
**Type:** Progress update + Decisions resolved (ADR-30, ADR-31 added; D-12 mechanism + defaults built)
**Summary:** Built the LLM reasoning core as 7 individually-committed slabs (`ed03590`, `9aae793`, `cd21ead`, `a14cbdd`, `2bd4f29`, `c5e903b`, `5fc869e`):
- `@corvid/tool-contracts` — the `hypothesize` LLM-output schema (strict, so the model can't smuggle a fingerprint/status), a compile-time `vulnClass` drift guard, the deterministic `fingerprint()` (ADR-D10: `hash(vuln_class + normalized method+path + param + payload family)`; id-like path segments templated, payload *family* keyed), and `hypothesisPlanSchema`.
- `@corvid/llm` — the **only** LLM importer in the repo (ADR-01/ADR-23). OpenRouter chat-completions client over an injectable `fetch`; opts into per-call cost with `usage:{include:true}` and reads `usage.cost`/`is_byok` (verified against OpenRouter docs via Context7). `LlmResult` carries cost on **both** the ok and invalid-output branches so the caller records spend **before** acting (ADR-21). Transport/gateway failures are typed `InfraError` (retryable on 429/5xx), never a clean negative (§4). Ships `createStubLlmClient` for offline tests. Model slugs live only here (ADR-23).
- `@corvid/db` — `llm_calls` spend ledger (migration `0003`) + `recordLlmCall`/`sumDailyLlmSpend` + pure `evaluateDailySpend`/`utcDayStart`/`DEFAULT_DAILY_SPEND_CEILINGS` (fail-closed daily hard-stop, ADR-21); `hypotheses.plan` jsonb + unique `(scan_id, fingerprint)` (migration `0004`) + `insertHypotheses` (replay-safe `onConflictDoNothing` upsert, ADR-27) / `listHypothesesForScan` / `setHypothesisPlan`.
- `@corvid/redis` — `HypothesisDedup`, the per-scan fingerprint cache (mirrors `CrawlFrontier`, fail-closed on a lost pipeline). The DB unique index is the durable authority; the cache can be flushed without risking a duplicate.
- `@corvid/agent-core` (new **package**, not `apps/*` — `@corvid/scan-runtime` imports it to wire the graph, and a package can't depend on an app; consistent with ADR-18) — `perceive` (pure crawl-map → surface), `hypothesize` (spend-stop → LLM → record-cost-before-parse → `generation_error` pause vs legitimate empty → replay-safe persist → warm cache; skips the billed call on an empty surface), `plan` (tester per class + intended payload, idempotent). Nodes are DI'd and unit-tested in isolation with a stub LLM and in-memory ports — no DB/Redis/network.
- `@corvid/scan-runtime` — the real nodes wired into the durable graph (`authorize→crawl→perceive→hypothesize→[generated?plan:markStopped]→awaitApproval→test→report`); reasoning ops injected so the graph tests without the crawler/DB/LLM; the Postgres approval-interrupt durability (restart-mid-pause) still proven.
**Verification:** `pnpm turbo run typecheck lint test build` green (56 tasks). New tests: fingerprint/contract (20), llm client+stub (11), spend guard + `llm_calls` integration vs live PG, hypotheses upsert-dedup vs live PG (3), `HypothesisDedup` vs live Redis, agent-core node logic (15 incl. spend-stop / record-before-parse / generation_error-vs-empty / batch+rerun dedup / plan mapping+idempotency / empty-surface skip), graph routing (4, MemorySaver). **Security & safety review** (code-review plugin, `2e0a52e..c5e903b`): verdict clean + well-tested; both launch invariants hold. 3 findings fixed (empty-surface billed call; lossy endpoint `source`; stuck `hypothesizing` status → new `stopped` state), 2 deferred with rationale (`llm_calls` blocks scan hard-delete — intentional, matches `audit_log`; record/persist non-transactional — inherent to external-bill + local-DB, favors cap-safety).
**Files/areas touched:** `packages/{tool-contracts,llm,db,redis,agent-core,scan-runtime}`; migrations `0003`/`0004`; `docs/specs/02` (§5 `llm_calls`+`plan`, §5.1 `stopped`), `03` §10 (D-12), `04` (ADR-30/31).
**Related decision:** **New — ADR-30** (`hypotheses.plan` jsonb) and **ADR-31** (`stopped` lifecycle state) added to `04`; both reflected in `02` §5/§5.1. **D-12** mechanism + conservative defaults built (global 5 / user 1 credits/day; values still raised in Unit 8 per the plan) — `03` §10 row updated. BYOK caveat recorded (credit cap inactive under BYOK; owner accepted for v1). D-10 consumed (ADR-D10). No launch invariant weakened.
**Safety check:** Both launch invariants **hold**. #1 (no active payload outside recorded authorization): agent core sends **no** payloads — the LLM only proposes `pending` hypotheses, and the durable approval `interrupt()` precedes every test node; the `@corvid/llm` boundary keeps network egress out of the reasoning core. #2 (no unverified finding in a report): agent core writes **hypotheses only**, never a finding; the verification gate (Unit 5) does not exist yet and the report writer (Unit 7) has no path here. The spend kill-switch degrades reasoning only, never verification (ADR-01/ADR-21).
**Follow-ups:** a live OpenRouter end-to-end run pends the API key (Unit 0). Deferred review items #3 (soft-delete/erasure story for `llm_calls`) and #4 (idempotent LLM billing/reconciliation) if promoted. `plan`'s concrete payloads + the `test`/`observe`/`verify` nodes are Units 4–5.

---

### [2026-08-11] Unit 2: crawler MCP + Redis frontier/dedup + rate-limit migration
**Unit:** Unit 2 — Crawler & Attack-Surface Mapping
**Type:** Progress update + Decision resolved (ADR-29/D-17 added)
**Summary:** Built the passive crawler as an MCP tool server plus its Redis foundation, verified against real infra:
- `@corvid/tool-contracts` — `crawler.map` contract (Zod v4). Wire input is **only `scanId` + optional bounds**; seed URL, scope, and recorded authorization are derived server-side from the scan's target row (a caller/LLM can't widen scope).
- `@corvid/redis` — ioredis client factory + per-scan `CrawlFrontier` (dedup set terminates a cyclic crawl) + the ioredis→hono-rate-limiter `RedisStore` adapter (with NOSCRIPT re-load recovery). Frontier dedup proven vs a real Redis.
- `apps/crawler` — Playwright engine (SPA-aware; `domcontentloaded` + bounded networkidle), context-level request interception, endpoint/param aggregation, form-login auth-flow **mapping** (replay deferred to Unit 6, D-1). Scope enforced identically for enqueue and for in-browser request abort (the ONE @corvid/scope source, ADR-24). Every crawl start/refusal/completion/failure audited (ADR-16); crawler is a `crawler` system actor.
- **Folded-in Unit 1 follow-ups:** gateway rate-limit store migrated to Redis (optional REDIS_URL; memory fallback for single-instance) — proven with a real Redis 429 test; crawl-action audit wiring done.
**Verification:** `pnpm turbo run typecheck lint test build` green (48 tasks). Deterministic crawl-loop safety tests (fake fetcher, no browser): out-of-scope seed refused+audited, out-of-scope link never enqueued/visited, blocked requests counted, empty-surface clean, bounds respected. **Real-browser E2E (opt-in `CRAWLER_E2E`, chromium): the crawler maps the in-scope surface and NEVER issues an out-of-scope request — fetch/img/xhr/link + popup navigation + WebSocket to an out-of-scope host are all aborted at the browser (fixture receives zero out-of-scope hits).** Integration (real PG+Redis): `getTargetForScan` C1 gate, Redis-backed rate-limit 429, frontier dedup.
**Self-review:** Sage reviewed the full diff. Fixed the invariant-relevant set: **C1** (authorization/scope/seed from the DB, not tool args), **C2** (context-level routing + block service workers/WebSockets/popups; page-level routing missed them), **H1** (maxPages bounds attempts not successes), **H2** (auth-flow only for in-scope forms), **H3** (re-check scope on sent requests + final endpoint filter choke point), **H4** (terminal `crawl.failed` audit on the error path), **H5** (log safe fields only — a Playwright error embeds the full URL incl. query), **M1** (IPv6 SSRF holes in `isDangerousHost`: loopback/ULA/link-local/IPv4-mapped), **M3** (uuid scanId + validate/re-scope dequeued items), **M9** (rate-limit NOSCRIPT recovery), **M10** (fail-closed route handler + boot `.catch`), plus §5 hygiene (strip userinfo, strip query from emitted auth-flow URLs) and per-page link cap (M6). **Deferred (tracked):** frontier TTL refresh mid-crawl (M4), frontier fail-closed on partial Redis error (M5), overall crawl deadline (M8), and the D-17 IP-level SSRF closure.
**Related decision:** **New — ADR-29 added to `04`; D-17 row added to `03` §10.** The crawler runs outside the E2B sandbox in v1 with name-based scope enforced in-browser; IP-level SSRF (DNS-rebind / private-IP resolution) closure deferred — a recorded risk acceptance, not a silent default.
**Safety check:** Invariant #1 (no active payload outside recorded authorization): not directly applicable — the crawler sends no payloads — but the analogous property, **no out-of-scope request**, holds and is proven end-to-end, and authorization is now read from the recorded target. Invariant #2 (no unverified finding in a report): not applicable — no findings path exists yet. Residual: name-based scope only (D-17).
**Follow-ups:** M4/M5/M8 hardening; D-17 resolve-and-pin (or crawl-in-sandbox) before a non-lab real target; the crawler's MCP tool handler authz gate has an integration test at the DB layer (`getTargetForScan`) but not yet a full tool-invocation e2e (needs a scan row + browser) — add in Unit 3/5 wiring.

---

### [2026-08-10] Unit 1 safety spine: db, scope, auth, runtime, sandbox, gateway
**Unit:** Unit 1 — Foundation
**Type:** Progress update + Decision resolved (ADR-28)
**Summary:** Built the rest of Unit 1 as six logical, individually-committed slabs, each verified against a real (dockerized) Postgres:
- `@corvid/scope` — one scope source → authz predicate + egress allow-list (§3, ADR-24); rejects dangerous hosts (loopback/private/link-local/169.254.169.254/localhost) as SSRF defense-in-depth, fail closed.
- `@corvid/db` — full `02` §5 schema in Drizzle (**ADR-28**: Drizzle + drizzle-kit), owner-scoped repos (not-owned → undefined → 404), **structurally immutable audit log** via triggers that RAISE on UPDATE/DELETE/TRUNCATE (ADR-16), atomic concurrent-scan cap (`createScanWithinCap`, advisory-locked txn).
- `@corvid/auth` — Better Auth (email/password) on the Drizzle adapter, DB-generated uuids; `resolveUserId` (ADR-19).
- `@corvid/scan-runtime` — durable LangGraph scan graph + Postgres checkpointer; approval `interrupt()`/`Command` resume **proven to survive a restart mid-pause**; OOB-timeout sweep stub (D-4).
- `@corvid/sandbox` — E2B per-burst sandbox skeleton; two enforcement layers computed from one scope (refuse-without-authz never touches E2B; egress denyOut-all + allowOut = scope hosts + OOB); authz asserted positive (fail closed).
- `apps/gateway` — thin Hono gateway: auth mount + guard, per-user rate limit + IP-keyed auth-surface limit, owner-scoped routes (404-not-403), atomic concurrent-scan cap, refuse-unauthorized scan start, typed `onError`; env validated fail-closed.
**Verification:** `pnpm turbo run typecheck lint test build` green (40 tasks). Integration suite (opt-in via DATABASE_URL) 18 pass / 1 skipped: cross-tenant 404 (repo + over-HTTP), append-only audit (UPDATE/DELETE rejected), sign-up uuid, restart-durability, rate-limit 429, concurrent-scan-cap 429, refuse-unauthorized 403, SSRF-host reject. Self-reviewed via Sage; applicable High findings fixed (fail-closed authz, atomic cap, immutable audit, auth-surface rate limit, SSRF hosts, strict schemas).
**DoD status:** met except two lines **pending external (Unit 0)**: the live E2B firewall egress-denial proof (needs `E2B_API_KEY`), and deploy against managed Postgres/Redis. A dedicated whole-system safety review is Unit 8.
**Related decision:** **New — ADR-28 (Drizzle) added to `04`.** D-11 (abuse-limit values) remains open as config defaults.
**Safety check:** Both launch invariants **still not yet applicable** — no active-payload path and no findings path exist yet (no crawler/tester/verifier/LLM). Foundations that *enforce* those invariants later are in place: two-layer authz computed from one scope, egress allow-list derivation, immutable audit, tenant isolation. No code path here sends a payload or emits a finding.
**Follow-ups (deferred, non-blocking):** Redis-backed rate-limit store (when Redis lands, Unit 2); audit-write on every gateway action/refusal (ADR-16 — wire when the scan lifecycle is real); unified typed refusal error; resume-value validation at the approval gate (Unit 6); REVOKE UPDATE/DELETE/TRUNCATE + non-owner DB role (prod hardening); type-aware ESLint (`no-floating-promises`) for the async units; a formatter before dashboard work.

---

### [2026-08-10] Shared foundation packages: errors, logger, config (Unit 1)
**Unit:** Unit 1 — Foundation
**Type:** Progress update
**Summary:** Built the three dependency-free foundation packages every later unit relies on. `@corvid/errors` — typed hierarchy (`CorvidError` base + `ConfigError`/`AuthorizationError`/`TargetError`/`InfraError`, `isCorvidError`) matching §4's categories; verification-negative is deliberately excluded (it's `VerificationOutcome` in `tool-contracts`, a domain outcome not an exception). `@corvid/logger` — Pino v10 structured logger with **structural §5 secret hygiene**: a case-insensitive deep scrub (`formatters.log`) at any nesting depth, a `redact.paths` backstop for child bindings, and an `err` serializer that turns our typed errors into safe fields with `context` scrubbed; the message string is never scrubbable, so an ESLint rule bans interpolated/concatenated strings in log calls. `@corvid/config` — `parseEnv` schema-validation helper (Zod v4) that fails fast + closed (§9) and never echoes a received value or a `custom`-refinement message into the error (§5), wrapping `safeParse` so a throwing transform still surfaces a `ConfigError` (§4). Added `no-console` + the log-message rules + turned off the noisy `security/detect-object-injection` to the shared ESLint config. `pnpm turbo run typecheck lint test build` green (16/16); 23 tests incl. explicit §5 true/false cases (deep/case-insensitive redaction, message-leak proof, secret-not-echoed).
**Decisions (see AGENTS.md guideline):** Zod v4 as the single schema lib (matches MCP TS SDK v2's internal Zod ≥4.2 — one major, no dual-copy); Pino v10 for logging (`import pino from 'pino'`). Both verified against current docs before coding (§12).
**Self-review:** Sage reviewed the slab — verdict *Needs changes (narrowly)*, all in the §5 path. Fixed all three High findings (deep+case-insensitive redaction, log-message lint rule, `err` serializer), the Mediums (`InfraError.retryable` now required = fail-closed; Zod transform-throw + custom-message hardening), and the Lows (`path.map(String)`, `export {x as default}` ban, `assertNever` value-leak, `pid` attribution). **Deferred:** type-aware ESLint preset (`no-floating-promises`) — matters for the async Units 3–5, not these sync packages; add a `typeAware` config export when agent-core/tool-servers land.
**Files/areas touched:** `packages/errors/*`, `packages/logger/*`, `packages/config/*`, `packages/eslint-config/base.mjs`, `packages/tool-contracts/src/domain.ts` (assertNever), `pnpm-lock.yaml`.
**Related decision:** None resolved. D-11 (abuse-limit values) still open — belongs to the abuse-controls work later in this unit.
**Safety check:** Both launch invariants still **not yet applicable** — no payload path, no findings path, no network egress, no LLM client. This slab adds the log/secret-hygiene machinery the later units depend on to keep §5, but nothing here sends a payload or emits a finding.
**Follow-ups:** Next Unit 1 slabs (need Unit 0 provisioning for some): Postgres schema + append-only audit log → Better Auth + tenant isolation → LangGraph durable scan-runtime skeleton (managed Postgres) → E2B sandbox skeleton (E2B account) → abuse controls (D-11). Also: type-aware lint preset; a formatter (Prettier/Biome) before dashboard work.

---

### [2026-08-10] Monorepo scaffold (Unit 1, first bullet)
**Unit:** Unit 1 — Foundation
**Type:** Progress update
**Summary:** Stood up the repo shape from `CODING_STANDARDS.md` §2 / ADR-18: a pnpm-workspaces + Turborepo monorepo. Root tooling (`package.json`, `pnpm-workspace.yaml`, `turbo.json` with `build`/`test`/`lint`/`typecheck` tasks, `.gitignore`), two shared config packages (`@corvid/typescript-config` — strict base incl. `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`; `@corvid/eslint-config` — flat tseslint + `eslint-plugin-security` + named-exports-only rule scoped to TS per §1), and `@corvid/tool-contracts` as the first real `packages/*` — carrying the core domain discriminated unions from §1 (`ScanStatus`, `HypothesisStatus`, `VulnClass`, `VerificationOutcome`, `assertNever`) with two tests. `pnpm turbo run typecheck lint test build` is green across all packages; downstream consumption of the built package verified by a throwaway smoke typecheck.
**Toolchain notes (verified against current docs, not memory — `CODING_STANDARDS.md` §12):** Turborepo 2.x (`tasks`, not `pipeline`; `$schema` at `turborepo.dev`). TypeScript pinned to `~5.9` — TS 7 (native Go port) is out but typescript-eslint isn't TS7-ready yet. Test runner is Node 24's built-in `node --test` with native TS type-stripping — zero test dependency (dependency ladder: platform before a dep). Source uses `.ts` import specifiers; TS 5.9 `rewriteRelativeImportExtensions` rewrites them to `.js` on `tsc` build, so the same source runs under Node strip-types and emits correct JS — no bundler.
**Not built here (deliberately):** the eight `apps/*` are not stubbed — empty shells are speculative (YAGNI); each is created as its unit begins. The rest of Unit 1's safety spine (Better Auth + tenant isolation, Postgres schema + audit log, LangGraph durable runtime, E2B sandbox skeleton, abuse controls, env validation, logger) is not started and several depend on Unit 0 provisioning (managed Postgres/Redis, E2B account).
**Files/areas touched:** `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `.gitignore`, `apps/.gitkeep`, `packages/typescript-config/*`, `packages/eslint-config/*`, `packages/tool-contracts/*`, `pnpm-lock.yaml`.
**Related decision:** None — pure scaffold; ADR-18 already settled the shape. No D-## resolved (D-11 abuse-limit values still open, belongs to the abuse-controls work later in this unit).
**Safety check:** Both launch invariants **not yet applicable** — no payload path, no findings path, no network egress, no LLM client exists yet. The scaffold adds no code that could send a payload or emit a finding. The verification gate module does not exist yet (Unit 5).
**Follow-ups:** Next Unit 1 slabs, roughly in dependency order: env-validation + structured logger (§9/§13) and the error-class hierarchy → Postgres schema + append-only audit log → Better Auth + tenant isolation → LangGraph durable scan-runtime skeleton (needs managed Postgres from Unit 0) → E2B sandbox skeleton (needs E2B account from Unit 0) → abuse controls (owns D-11). No formatter (Prettier/Biome) wired yet — pick one before the dashboard/Canvas work starts.

---

_First execution entry above. Earlier planning stage recorded in `00`–`05` + `CODING_STANDARDS.md`._
