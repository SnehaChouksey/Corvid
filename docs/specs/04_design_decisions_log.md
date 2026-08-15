# Corvid — Design Decisions Log

**`04`** · Companion docs: [`00_project_overview.md`](00_project_overview.md), [`01_product_ux_flow_spec.md`](01_product_ux_flow_spec.md), [`02_system_architecture_spec.md`](02_system_architecture_spec.md), [`03_build_plan.md`](03_build_plan.md)
**Status:** Living document — grows as decisions are made
**Source of truth for:** how the design got to its current state — every decision made during planning, with the alternative(s) considered and its status.

---

## 0. What this document is

The other spec documents (`00`–`02`) describe the *current state* of the design. This one records *how it got there* — each decision, its alternatives, and its status. It exists so that no choice in the specs reads as an unexamined default, and so nobody re-litigates a settled decision without knowing it was settled (or discovers too late that an "obvious" choice was actually still open).

The build plan's §10 D-## table is the *register of open decisions and where they close*; this log is the *record of decisions and their reasoning*. Every ⚠️ entry here points at its D-## row; when a unit closes it, the entry here is updated with what was decided and the ADR becomes the reasoning of record.

### Scope: decisions that shape the system
What gets built, which technology, which tradeoff, which mechanism. Development-process conventions (doc verification, per-unit security review, code style) live in `../CODING_STANDARDS.md` and are deliberately not ADRs. If an entry here doesn't change what the software *is*, it's in the wrong document.

### Status legend
- ✅ **Confirmed** — decided directly during planning
- 🔧 **Designed, adopted** — proposed in the specs, not objected to, now load-bearing
- ⚠️ **Default assumption — not yet confirmed** — flagged as [Assumption] or an open question in `00`–`02`, tracked as a D-## row in `03` §10 with a named owning unit
- ⛔ **Superseded** — replaced by a later ADR (points forward)

### Open items requiring explicit resolution
As of the 2026-08-10 update, **every specs-level decision is resolved.** D-1–D-10 and D-13–D-16 are closed (mechanisms and methods decided; §C records each). The only things deliberately left open are **value knobs, not decisions**: D-11 (abuse-limit numbers) and D-12 (LLM spend ceilings) ship as conservative config defaults and are raised once real usage/cost is measured (Unit 8) — and the numeric *thresholds* inside the verification signals (D-13–D-16), which are calibrated against the practice labs in Unit 5. A threshold is a measurement, not a paper value; forcing one now would be the exact "refine on paper" trap the specs avoid. Temporal was removed (ADR-07 ⛔ → ADR-27).

---

## A. Product & scope

### ADR-01 — Verify, don't guess: verification is deterministic, never LLM-judged
**Status:** ✅ Confirmed (the founding principle)
**Alternatives considered:** an LLM confidence score gating findings (what thin "AI security" wrappers do); a rules engine with no exploit check (what classic scanners do).
**Decision:** a finding is reported only after a non-LLM, deterministic check proves the exploit fired — a correlated OOB callback, a provable auth-state transition, an error/time/boolean-differential signal. The LLM proposes and tests; it never decides "verified." This is the wedge: zero unverified findings.
**Rationale:** false positives are the failure mode that trains users to ignore a security tool. An LLM opinion reproduces that problem with a more confident voice. The reasoning being non-deterministic is fine; the verification being non-deterministic is not.
**Doc:** `00` §3, §7.1; `02` §4.4

### ADR-02 — Humans authorize active steps
**Status:** ✅ Confirmed (product pillar)
**Alternatives considered:** fully autonomous testing (explicit non-goal); no gate at all.
**Decision:** passive crawling proceeds autonomously; anything that sends a live test payload waits for explicit, per-hypothesis human approval at a gate. Silence is never consent — a scan pauses indefinitely rather than proceeding on a timeout.
**Doc:** `00` §7.2; `01` §6; `02` §3.3

### ADR-03 — No target touched without recorded authorization
**Status:** ✅ Confirmed (safety-critical)
**Decision:** a scan cannot start without a recorded authorization (actor + timestamp) for the exact current scope, and this is enforced in the workflow, not in policy. Editing scope invalidates prior authorization. Enforced a second time at the sandbox egress layer (ADR-08), defense-in-depth.
**Rationale:** pointing active testing at an out-of-scope host is the failure that ends a project like this. One enforcement layer is a single point of failure for a safety-critical property.
**Doc:** `00` §7.3; `01` §3; `02` §7

### ADR-04 — v1 covers four vuln classes with real verification, not breadth
**Status:** ✅ Confirmed
**Alternatives considered:** broad shallow coverage of many CVE/vuln classes (what scanners advertise).
**Decision:** v1 covers JWT algorithm/key confusion, SSRF (incl. blind), SQL/NoSQL injection, and IDOR — each with a deterministic verification signal — rather than twenty classes done shallowly. Each was chosen because it *needs* agentic reasoning, an OOB verification loop, or cross-session comparison.
**Rationale:** the product's claim is depth of proof, not coverage count. Breadth without verification is the thing being displaced.
**Doc:** `00` §6, §9; `05` (deferred classes)

### ADR-05 — Report from verified findings only; the report writer sees no raw reasoning
**Status:** ✅ Confirmed
**Decision:** the Report Writer reads `findings.verified = true` only and has no code path to raw, unverified agent hypotheses. Verified-only is enforced at the consumer, not merely by a query filter.
**Rationale:** the report is the artifact a customer trusts; a single unverified item leaking in defeats the entire premise (ADR-01).
**Doc:** `00` §7.1; `02` §4.4; `03` Unit 7

### ADR-06 — Autonomous remediation is out of v1 scope
**Status:** ✅ Confirmed
**Decision:** v1 reports to a human; it does not open fix PRs or modify the target. Auto-fix is a possible future extension (`05`), not v1.
**Doc:** `00` §6 non-goals

---

## B. Architecture & technology

### ADR-07 — Temporal owns the scan lifecycle ⛔
**Status:** ⛔ Superseded by ADR-27 (2026-08-10)
**Was:** Temporal orchestrates the durable scan lifecycle — the two waits (human approval, OOB callback) survive crashes without holding a thread.
**Why superseded:** the analysis that justified Temporal assumed OOB waits of "seconds to **hours**"; D-4 later bounded the OOB wait to **5 minutes**, leaving human approval as the only days-long pause — and LangGraph.js's durable `interrupt()` + Postgres checkpointer handles exactly that pattern natively, on the Postgres already in the stack. Temporal became a heavyweight managed service whose one irreplaceable feature (long durable timers) we no longer need. Removed — see ADR-27.
**Doc:** superseded — see ADR-27

### ADR-08 — Per-scan sandbox with egress allow-list (host-level)
**Status:** ✅ Confirmed (safety-critical) — runtime is E2B per ADR-22; egress granularity clarified by ADR-24
**Alternatives considered:** application-level URL filtering only; a shared execution environment across scans.
**Decision:** each active-testing burst runs in an ephemeral sandbox whose network egress is allow-listed to the authorized target host(s) + the OOB listener only, derived from the target's scope. Enforced at the sandbox-firewall level (ADR-22, E2B `denyOut: all` + `allowOut: [target, OOB]`) so an application bug cannot widen it. No shared state between concurrent scans of different targets. A denied egress is audited and flags the hypothesis that attempted it.
**Egress is host-level (ADR-24).** The firewall allow-list works on host/IP (Host header on :80, SNI on :443) and cannot see request paths inside TLS — so finer-than-host scope is enforced above the network, in `http.send` (ADR-24). Egress remains the host backstop.
**Rationale:** the egress boundary is the last line between authorized testing and unauthorized internet traffic; it must not depend on application logic being correct.
**Doc:** `00` §7.4; `02` §7, §11; `04` ADR-22, ADR-24

### ADR-09 — Self-hosted OOB callback listener for blind-vuln verification
**Status:** ✅ Confirmed
**Alternatives considered:** a third-party interaction service; inferring blind SSRF from response timing alone.
**Decision:** a self-hosted Interactsh-style listener registers unique per-test tokens and correlates inbound callbacks; a correlated callback is the only proof of a blind SSRF/XXE. The listener sits inside the system boundary and, on a match, resumes the paused scan graph (the LangGraph interrupt for that hypothesis, ADR-27).
**Rationale:** blind vulnerabilities cannot be verified from the HTTP response; an external callback the target itself makes is the only deterministic signal (ADR-01). Self-hosting keeps the proof artifact and the correlation under the system's control.
**Doc:** `00` §8; `02` §3.2, §4.4

### ADR-10 — LangGraph agent core as an inspectable state machine
**Status:** ✅ Confirmed
**Alternatives considered:** a single opaque prompt chain / ReAct loop.
**Decision:** the reasoning loop is LangGraph nodes — perceive, hypothesize, plan, act, observe, verify — each named, individually testable, and loggable. The `verify` node delegates to the deterministic gate (ADR-01), not to the LLM.
**Rationale:** every transition needs to be inspectable and testable in isolation for both debugging and auditability; an opaque chain can't give that.
**Doc:** `00` §8; `02` §1; `03` Unit 3

### ADR-11 — MCP tool isolation: each testing capability is an independent tool server
**Status:** ✅ Confirmed
**Alternatives considered:** embedding vuln-class logic directly in the agent core; a monolithic tester.
**Decision:** crawler, HTTP-send, JWT mutator, SSRF checker, injection fuzzer, and IDOR tester are independently deployable, independently testable MCP servers with additive-only contracts. The agent core embeds no vuln-specific logic and never touches the target network directly — all traffic flows through a tool server inside the sandbox.
**Rationale:** it lets the reasoning be tested without the network and each tool be tested without the reasoning (replay a fixed hypothesis against one tester), and it makes the egress boundary (ADR-08) enforceable because the agent has no direct socket.
**Doc:** `00` §7.5; `02` §1, §10

### ADR-12 — Kafka event bus decouples finding-verified from its consumers ⛔
**Status:** ⛔ Superseded by ADR-17
**Alternatives considered:** direct writes from the verifier to each consumer; a lighter in-process pub/sub.
**Decision (original):** `scan.progress`, `finding.detected`, and `finding.verified` are Kafka topics; the findings store, report writer, audit log, and dashboard feed consume independently.
**Why superseded:** v1 is free-hosted, and Kafka is a whole service to operate for a scale v1 never reaches (`05` B2's trigger was never going to fire first). Redis is already in the stack (crawl frontier + dedup), so the finding fan-out consolidates onto it — see ADR-17. The decoupling *property* is kept; only the mechanism changed.
**Doc:** superseded — see ADR-17

### ADR-17 — Redis (BullMQ + pub/sub) replaces Kafka for finding fan-out
**Status:** ✅ Confirmed (owner, 2026-08-10) — supersedes ADR-12
**Alternatives considered:** keep Kafka (operational weight unjustified at v1 scale, not free-hostable simply); NATS/RabbitMQ (another service to host); direct synchronous writes from the verifier to every consumer (recouples the thing ADR-12 decoupled).
**Decision:** the event-bus role splits into two mechanisms, both on the **one Redis instance already in the stack** (ADR-13):
- **BullMQ (Redis-backed job queue)** for *durable* async work — persisting a `finding.verified`, triggering report generation. Jobs survive a worker restart and retry on failure, which is the property that matters for anything that must not be lost.
- **Redis pub/sub** for the *realtime* dashboard fan-out (`scan.progress`, live findings). Fire-and-forget by design: it's fine to drop a live update because the durable truth is in PostgreSQL and the dashboard reconciles on reload. Never the path for anything that must not be lost.
**Rationale honestly stated:** BullMQ is a job queue, not a pub/sub bus, so it is not a drop-in for Kafka's topic-fan-out. But at v1 the real consumers are few and their needs are asymmetric — "persist/trigger, durably" vs. "show it live, best-effort" — and that asymmetry maps exactly onto queue vs. pub/sub. The audit log was never really a bus consumer: every process writes its audit record synchronously at the point of action (ADR-16, `02` §4.2), so it needs no queue at all. Consolidating on Redis removes an entire hosted service and its ops surface.
**Invariant preserved:** losing a durable consumer still doesn't lose the finding — the finding is persisted before/at the BullMQ enqueue, and jobs retry. The verified-only report path (ADR-05) is unaffected: the report writer reads verified findings from PostgreSQL, triggered by a durable job.
**Reconsider if:** scan/finding throughput ever outgrows a single Redis, or a genuine many-independent-consumer pattern appears — at which point `05` B2's original trigger (now inverted) re-enters through a new ADR.
**Doc:** `00` §8; `02` §1, §2, §8, §11; `03` Unit 7; `05` B2

### ADR-18 — TypeScript everywhere, one monorepo on pnpm workspaces + Turborepo
**Status:** ✅ Confirmed (owner, 2026-08-10) — resolves the language posture that `CODING_STANDARDS.md` §0 had held open as an [Assumption]
**Alternatives considered:** a polyglot repo (TS frontend/gateway + Python agent core & tools, since LangGraph is Python-first) — rejected because it splits the shared MCP tool contract across two languages, forcing a JSON-Schema-generates-both-sides layer and two workspace toolchains; multiple repos — rejected because the tool contract is additive-only and shared by producers and consumers, so a contract change must land atomically (see below); pnpm workspaces alone without Turborepo — a valid start, but the task-caching layer earns its place across ~8–9 packages and in CI.
**Decision:** every component is **TypeScript, strict mode** — dashboard (Next.js), API gateway (Hono), LangGraph agent core + scan-runtime worker (LangGraph.js), all MCP tool servers, and the OOB listener. They live in **one monorepo** managed by **pnpm workspaces + Turborepo**, with `apps/*` for deployables and `packages/*` for shared code — the MCP tool contracts and shared schemas being the load-bearing shared package.
**Rationale:** the MCP tool contract (`02` §10, `CODING_STANDARDS.md` §8) is the boundary between the agent core, the six tool servers, the gateway, and the dashboard, and it is additive-only — a change to it must land atomically across producers and consumers, or a version skew produces a wrong result in a security tool. All-TypeScript keeps that contract a single imported package rather than a generated cross-language artifact, and keeps one type system, one test runner, and one lint config across the repo. Turborepo adds task pipelines and build/test caching that matter as the package count grows and in CI.
**Cost accepted, stated plainly:** LangGraph's TypeScript SDK is less mature than its Python one, and some agent-tooling examples will be Python-first — verify against the JS SDK's current docs before coding (`CODING_STANDARDS.md` §12), and treat any capability gap as a real risk to surface, not to paper over.
**Doc:** `CODING_STANDARDS.md` §0, §2, §11, §12; `00` §8; `02` (constraints); `03` Unit 1

### ADR-13 — PostgreSQL primary datastore; Redis for frontier + dedup
**Status:** 🔧 Designed, adopted
**Decision:** PostgreSQL holds targets, scans, hypotheses, findings, and the append-only audit log — relational integrity matters (a finding must reference a real hypothesis and scan). Redis holds the crawl frontier queue and the hypothesis dedup cache (hot, ephemeral, keyed on fingerprint).
**Rationale:** the durable, referential data is relational by nature; the frontier/dedup data is hot and disposable — different tools for different jobs.
**Doc:** `02` §4.5, §5, §8

### ADR-14 — Playwright for crawling
**Status:** 🔧 Designed, adopted
**Alternatives considered:** a raw HTTP crawler.
**Decision:** the Crawler MCP is Playwright-driven, to map JS-rendered SPAs and multi-step auth flows a raw HTTP crawler would miss.
**Doc:** `00` §8; `02` §10; `03` Unit 2

### ADR-15 — Next.js + shadcn/ui dashboard; Hono API gateway (thin)
**Status:** 🔧 Designed, adopted
**Decision:** the dashboard is Next.js + shadcn/ui (scan config, live feed, approval gate). The API gateway is Hono and is deliberately thin — auth resolution, input validation, calling a core service or signaling the workflow, shaping the response. No business logic in the gateway.
**Rationale:** keeping the gateway thin is what keeps the workflow and core services the single home of behavior, testable without an HTTP layer.
**Doc:** `00` §8; `02` §1, §6

### ADR-16 — Everything is audited (append-only, no process exempt)
**Status:** ✅ Confirmed
**Decision:** every process writes an audit record (actor, action, timestamp, detail) to an append-only log; the agent and the human are both actors in the same log. The audit trail is a first-class deliverable, not debug output.
**Rationale:** accountability for active testing, and a real security tool must produce an audit trail. No process is exempt (`02` §4.2).
**Doc:** `00` §7.6; `01` §10; `02` §4.2, §7

---

## B2. Platform self-protection

These four decisions protect Corvid *itself* — its users, its bill, and its integrity as a tool that must not be weaponized. They are distinct from the target-facing safety in §A/§B: those stop Corvid attacking an unauthorized target; these stop Corvid being abused, drained, or crossed between tenants.

### ADR-19 — Better Auth for platform authentication; single-user tenancy in v1
**Status:** ✅ Confirmed (owner, 2026-08-10)
**Alternatives considered:** no auth / trusted-operator assumption — rejected: the authorization gate (ADR-03) is only as strong as *who was allowed to click Authorize*, so an unauthenticated platform makes the whole safety story hollow; org/team tenancy from day one (Better Auth organization plugin) — deferred to V2 (`05` A-tenancy) because v1's users are individual analysts and a team model is schema surface with no v1 demand; a hand-rolled auth layer — rejected, no reason to build what Better Auth provides.
**Decision:** authentication is **Better Auth** (email/password + provider sign-in), sessions for the dashboard. **Every domain row — targets, scans, hypotheses, findings, audit records — is scoped to an owning user, and every REST/dashboard request resolves to exactly one user; there is no cross-tenant read path.** v1 is single-user accounts; org/team tenancy is a clean V2 upgrade via Better Auth's organization plugin.
**Rationale:** this closes the gap that the authorization gate depends on — a recorded authorization means nothing if anyone can create it. Tenant isolation is enforced in the data layer (owner-scoped queries), verified by direct calls, not UI absence.
**Doc:** `00` §8, §11; `01` §2–3; `02` §5, §6, §7; `03` Unit 1; `05`

### ADR-20 — Platform-side abuse controls: API rate limiting + per-user concurrent-scan cap
**Status:** ✅ Confirmed (owner, 2026-08-10) — mechanism confirmed; specific limits are D-11
**Alternatives considered:** relying only on the per-target rate posture (D-2) — rejected: that protects the *target*, not Corvid, and does nothing about a user spamming scan creation or hammering the API; no cap at all — rejected: one user could exhaust the sandbox/worker pool and deny service to everyone (a shared-fate outage on free hosting).
**Decision:** the Hono gateway enforces **per-user rate limits** on mutating endpoints (scan creation especially) and the auth surface, and a **per-user cap on concurrent running scans** checked at workflow start. Both are config values (D-11), tunable post-launch, defaulting conservative. A refusal is a clean, typed response (retry-after / cap-reached), never a silent drop and never a 500.
**Rationale:** distinct from D-2 because the thing being protected is Corvid, not the target. The concurrency cap is what bounds sandbox/worker exhaustion — the one resource whose abuse takes the whole platform down.
**Doc:** `02` §6, §7, §8; `03` Unit 1; `03` §10 (D-11)

### ADR-21 — LLM spend ceiling + kill-switch on the reasoning path
**Status:** ✅ Confirmed (owner, 2026-08-10) — mechanism confirmed; specific ceilings are D-12
**Alternatives considered:** measure-only (Unit 8) with no ceiling — rejected: measurement tells you about the bill *after* it lands, and on free hosting an uncapped hypothesis-generation/report loop is a real runaway; a per-scan token cap only — kept as one control but insufficient, since many cheap scans still sum to a large day.
**Decision:** the two LLM call sites — hypothesis generation (`hypothesize`) and report writing — record per-call cost at the call site, and a **daily spend hard-stop** (global, and a per-user ceiling) refuses further LLM-billed calls with a retryable error once tripped, until UTC midnight. Ceilings are config (D-12), defaulting conservative and raised deliberately once real per-scan cost is measured (Unit 8). The refusal is a typed domain outcome the scan surfaces, never a swallowed error or a silent proceed-on-empty.
**Rationale:** the verification gate is non-LLM (ADR-01), so a spend stop degrades *reasoning throughput*, never *finding integrity* — a safe thing to fail closed on. Cost recorded at the call site (not a best-effort audit) is what makes both the stop and the Unit 8 measurement trustworthy.
**Doc:** `00` §11; `02` §3.2, §7, §8; `03` Unit 3, Unit 8; `03` §10 (D-12)

---

## B3. Runtime, integrations & operational shape

### ADR-22 — E2B as the sandbox runtime; sandbox lifecycle = active-testing burst
**Status:** ✅ Confirmed (owner, 2026-08-10) — implements ADR-08's egress boundary; resolves the sandbox half of D-9
**Alternatives considered:** self-managed Docker + iptables on a VPS (rejected: we'd hand-roll the egress firewall that is the safety boundary, and it isn't cleanly free-hostable); no per-scan isolation (rejected outright — concurrent scans of different targets must not share state or network).
**Decision:** active testing runs in an **E2B** sandbox (Firecracker microVM, TS SDK — matches ADR-18), created with `network.denyOut: [allTraffic]` + `allowOut: [target host(s), OOB domain]` — the ADR-08 allow-list enforced at E2B's firewall, verified against E2B docs (`allowOut`/`denyOut`, domain filtering on :80 Host / :443 SNI). Free-tier credits cover v1.
**The lifecycle changed and it matters:** E2B caps sandbox lifetime (1h Hobby / 24h Pro), so a sandbox **cannot span a whole scan** — scans pause for human approval (possibly days) and wait on OOB callbacks (up to D-4). The sandbox is therefore scoped to the **active-testing burst**: created *after* approval, torn down when testing ends. The approval pause and OOB waits hold **no** sandbox — the scan graph is durably suspended (ADR-27) and the OOB listener lives outside the sandbox (ADR-09). This is cleaner, not a workaround: it matches "hold no resource during a wait."
**Bonus alignment:** E2B warns that a *blocked* egress can look like a successful TCP connect from inside (the firewall accepts, then drops) — so "the socket opened" is never proof of reachability. That is exactly Corvid's rule (verify by application-level / OOB signal, never a socket), reinforcing ADR-01.
**Doc:** `00` §8; `02` §1, §2, §7, §8, §9; `03` Unit 1; amends ADR-08

### ADR-23 — OpenRouter as the LLM gateway
**Status:** ✅ Confirmed (owner, 2026-08-10)
**Alternatives considered:** a single provider direct (less swap-friendly); a local/open model (heavier infra for v1).
**Decision:** hypothesis generation and report writing call LLMs through **OpenRouter** — one integration, model choice without per-provider SDKs, and per-call cost metadata returned (which the ADR-21 spend recording and kill-switch read directly). Model slugs live only in the LLM client module; call sites pass a purpose, never a slug (`CODING_STANDARDS.md` §3-analogue).
**Rationale:** the reasoning path is the one place model choice will churn; a gateway makes that a config change, and its cost metadata is what makes the spend cap trustworthy at the call site.
**Doc:** `00` §8; `02` §1, §3.2; `03` Unit 0, Unit 3; ties to ADR-21

### ADR-24 — Scope model: host-level egress + path-level scope enforced in `http.send`, audited
**Status:** ✅ Confirmed (owner, 2026-08-10)
**Alternatives considered:** host-level scope only (simpler, zero scope/enforcement gap, but can't express "in-scope host, out-of-scope path"); path scope with no dedicated enforcer (unsafe — egress can't see paths).
**Decision:** scope may be finer than a host. The egress allow-list (ADR-08/22) enforces the **host** boundary; **`http.send` enforces path/route scope on every request** before sending, because the firewall structurally cannot see a path inside TLS. Any out-of-scope-path attempt is **refused and audited/flagged** like a denied egress — a tester trying to leave path scope is itself a signal.
**Rationale:** an in-scope host with an out-of-scope path (shared host, partial authorization) is a real case; relying on egress alone would silently allow it. Two layers again: host at the firewall, path in the one shared HTTP tool.
**Doc:** `01` §3; `02` §7, §10; `03` Unit 4; amends ADR-08

### ADR-25 — Hypotheses are tested sequentially within a scan (v1)
**Status:** ✅ Confirmed (owner, 2026-08-10)
**Alternatives considered:** bounded parallelism (faster, but complicates the per-target rate posture and the audit ordering); configurable per scan (premature).
**Decision:** within one scan, approved hypotheses are tested **one at a time**. Simplest to reason about, keeps the per-target rate posture (D-2) trivially bounded, and gives a clean linear audit trail. Parallelism is a `05` item promoted only on an observed duration problem.
**Doc:** `02` §3.1, §8; `03` Unit 4; `05`

### ADR-26 — Report deliverable: dashboard view + JSON + PDF
**Status:** ✅ Confirmed (owner, 2026-08-10)
**Decision:** the verified-only report (ADR-05) is available three ways: read in the dashboard, exported as **JSON** (machine-readable findings + proof artifacts, for tooling/integration), and exported as **PDF** (the shareable pentest-style deliverable). All three render from the same verified-findings source; none has a path to unverified reasoning.
**Doc:** `01` §9, §11; `02` §6; `03` Unit 7

### ADR-27 — LangGraph durable checkpointer owns the scan lifecycle; Temporal removed
**Status:** ✅ Confirmed (owner, 2026-08-10) — supersedes ADR-07
**Alternatives considered:** keep Temporal (rejected — see below); Temporal-Cloud-lite / self-hosted Temporal (another managed service or a heavy self-hosted cluster for durability we can get from Postgres); a plain job queue + DB state machine (loses the clean pause/resume semantics).
**Decision:** the durable scan lifecycle is owned by **LangGraph.js with a durable Postgres checkpointer** (`@langchain/langgraph-checkpoint-postgres`, on the Postgres already in the stack, ADR-13). The reasoning graph and the lifecycle are one durable graph, keyed by scan id:
- **Human-approval pause** = a LangGraph `interrupt()` — state is checkpointed to Postgres, the process holds nothing, and the approval handler resumes days later (even after a deploy/crash) via `Command({resume})`. This is LangGraph's documented, production human-in-the-loop pattern.
- **OOB callback wait** = a per-hypothesis `interrupt()`; the OOB listener resumes it on a correlated callback. The **5-minute timeout (D-4)** is enforced by a small periodic **OOB-timeout sweep** — a job that resumes any OOB interrupt older than the timeout with "not confirmed." (LangGraph has no durable timer; this sweep is the ~10-line replacement, and D-4's 5-minute bound is why that's sufficient.)
- **Crash recovery** = checkpoint-per-node; a restart resumes at the last completed node.
- **Retries** = per-node `retryPolicy`.
**Why this over Temporal:** the only Temporal feature we can't reproduce cheaply is **long durable timers**, and D-4 bounded the OOB wait to 5 minutes, so we don't need them. Everything else (durable pause, crash recovery, retries) LangGraph gives natively, on Postgres we already run — removing an entire heavyweight managed service, consolidating state, and fitting all-TS (ADR-18) + free hosting.
**Two invariants this makes load-bearing, stated plainly:** (1) LangGraph nodes re-run from their start on resume, so **node idempotency is mandatory, not good-practice** — a crash mid-node replays it, and our `http.send` dedup is what makes a replayed payload safe (this is why we don't need Temporal's exactly-once). (2) The **checkpointer store is production data** — backed up, and migrated carefully, because a code change can make an old checkpoint unresumable; the OOB-timeout sweep also serves as the backstop that no paused scan lingers forever.
**Reconsider if:** v1 ever grows to high-concurrency, many-branch, hours-to-days orchestration with per-branch durable timers (the `05` multi-target-campaign territory) — at which point Temporal (or equivalent) re-enters through a new ADR that supersedes this one.
**Doc:** `00` §7.3, §8; `02` §1, §3, §8, §9, §11; `03` Unit 1; `CODING_STANDARDS.md` §3, §7, §14; supersedes ADR-07

---

## C. Open assumptions (⚠️ — tracked in `03` §10)

Each of these is a real decision the specs did not settle. They are recorded here so they read as open, not as defaults, and each has an owning unit.

### ADR-D1 — Target credentials are analyst-supplied at scan config ✅ (resolved 2026-08-10)
**Status:** ✅ Resolved — D-1, Unit 4
**Question (was):** how are two authenticated sessions at different privilege levels provisioned per target for `idor.compare`?
**Resolution:** the analyst supplies **all** target credentials at scan config — resolving three needs that had been fuzzy: (a) login credentials for the crawler to map authenticated surface, (b) a sample JWT for the JWT tester, and (c) the two accounts at different privilege for `idor.compare`. Corvid does not provision accounts on the target; it uses what the analyst provides, stored encrypted at rest and scoped to the target (`02` §7). This keeps Corvid out of the business of creating accounts on someone else's app and makes the privilege levels explicit rather than inferred.
**Doc:** `01` §4; `02` §5, §6, §10; `03` Unit 4, Unit 6

### ADR-D2 — Per-target rate-limiting posture ✅ (resolved 2026-08-10)
**Status:** ✅ Resolved — D-2, Unit 4
**Resolution:** a **conservative default request rate per target** (config, low by default) plus **adaptive backoff** — on a 429, a 403, or WAF/IDS-shaped responses, `http.send` backs off and slows, rather than pushing through. The analyst can override the rate at scan config for a target that tolerates more. Because testing is sequential in v1 (ADR-25), the effective ceiling is already one in-flight request; the rate posture governs the pacing between them. Enforced in `http.send` (one place, per ADR-24), not per tester.
**Values are config, tuned per target** — the mechanism is fixed, the numbers aren't a paper decision.
**Doc:** `02` §4.3, §7; `03` Unit 4

### ADR-D3 — Severity scoring: CVSS 3.1 base score + vector ✅ (resolved 2026-08-10)
**Status:** ✅ Resolved — D-3, Unit 7
**Alternatives considered:** CVSS 4.0 (newer, arguably better, but less familiar and less tooling support today); a custom Critical/High/Med/Low rubric (simpler, but less credible/portable for a security deliverable).
**Resolution:** each verified finding carries a **CVSS 3.1 base score and its vector string**. 3.1 is the lingua franca — every security team reads it and tooling ingests the vector — which matters for a report meant to be trusted and acted on. Store both the numeric score and the vector on the finding; a human-readable band (Critical/High/…) is derived from the score, not stored separately. Validated against real findings in Unit 8.
**Doc:** `02` §5; `03` Unit 7

### ADR-D4 — OOB timeout: 5-minute wait; late callback = audit note only ✅ (resolved 2026-08-10)
**Status:** ✅ Resolved — D-4, Unit 5
**Resolution:** a blind (SSRF/XXE) hypothesis waits **5 minutes** (config) for a correlated callback before being marked **not confirmed** — most server-side fetches fire within seconds, so 5 minutes is generous without lengthening scans much. The wait is a LangGraph `interrupt()` released either by the OOB listener (callback) or the **OOB-timeout sweep** (ADR-27) at the 5-minute mark. A callback that arrives **after the scan has closed** is recorded in the audit trail and surfaced as an informational note; it is **never auto-added to a closed report** (that would reopen a verified-only artifact after the fact, `01` §12).
**Why 5 minutes matters beyond UX:** it's the reason we don't need Temporal's long durable timers (ADR-27) — a 5-minute bound is comfortably served by a periodic sweep.
**Doc:** `01` §12; `02` §3.2, §8; `03` Unit 5

### ADR-D7 — Authorization proof-of-control: DNS TXT or well-known file, Corvid-verified ✅ (resolved 2026-08-10)
**Status:** ✅ Resolved — D-7, Unit 6
**Alternatives considered:** DNS-TXT-only (strongest, but awkward when the user controls the app but not DNS); uploaded authorization document with human review (fits third-party engagements but manual, not self-serve).
**Resolution:** before a target can be authorized, the user must satisfy a **proof-of-control** step: place a Corvid-issued token either in a **DNS TXT record** on the target domain **or** in a file at **`/.well-known/`** on the target, and Corvid **fetches and verifies it** before `authorization_confirmed_at` is stamped. This is the standard bug-bounty proof — it can't be faked by clicking, it's fully automated/self-serve, and the two options cover both "controls DNS" and "controls the app." Bound to the authenticated user (ADR-19); the verification result and method are stored in `targets.proof_of_control`. The invariant from ADR-03 (deliberate, recorded, timestamped, actor-attributed) holds, now with proof.
**Deferred variant:** an uploaded-authorization-document path for third-party authorized engagements (tester ≠ asset owner) is a `05` item — not v1, since v1's users test their own assets.
**Doc:** `01` §3, §13; `02` §5, §7; `03` Unit 6; ADR-19 (identity this binds to)

### ADR-D9 — Hosting/runtime: sandbox + durability + secrets ✅ (resolved 2026-08-10)
**Status:** ✅ Resolved — D-9, Unit 1
**Resolution:** split by concern. **Sandboxes → E2B** (ADR-22), which also owns the egress firewall. **PostgreSQL + Redis → managed free tiers**; durability rides Postgres via the LangGraph checkpointer (ADR-27), so there is **no separate workflow service** to host. **OOB listener → one small always-on host with a domain + wildcard DNS** (the one piece needing public inbound + DNS control, which free app-tiers can't provide). **Secrets** (target credentials + encryption key) live in the environment/secret store of each service; no cloud-KMS in v1.
**Updated 2026-08-10 (ADR-27):** the original resolution named Temporal Cloud as a managed tier — removed with Temporal. Durability now lives in the Postgres checkpointer, which *reduces* the hosting footprint: no Temporal cluster/Cloud, one fewer managed service, state consolidated in Postgres.
**Rationale:** no single free platform does egress-controlled microVMs *and* wildcard-DNS inbound, so those two go where each is capable (E2B; a tiny DNS box); everything stateful is Postgres/Redis managed tiers.
**Doc:** `02` §9; ADR-22 (sandbox), ADR-27 (durability), ADR-09 (OOB listener)

### ADR-D10 — Hypothesis fingerprint scheme ✅ (resolved 2026-08-10)
**Status:** ✅ Resolved — D-10, Unit 3
**Resolution:** the dedup fingerprint is `hash(vuln_class + normalized method+path + parameter name + payload family)`. Path is normalized (trailing slashes, obvious id-like path segments templated) so trivially-different URLs for the same endpoint collapse; **payload *family*** (not the exact payload) is keyed so re-testing the same weakness with a variant payload dedups, while a genuinely different class/param/endpoint does not. Scoped per scan (the dedup cache is per-scan, ADR-13). Calibrate the path-normalization and family buckets against the practice labs so it neither re-sends nor over-collapses.
**Doc:** `02` §5, §8; `03` Unit 3

### Verification-signal decisions (the product's core — methods resolved 2026-08-10)

Zero-false-positives (ADR-01) rests entirely on each class's deterministic signal being *right*, so each is a tracked decision. The **method + false-positive guard is resolved below**; the exact numeric thresholds (sample counts, delay margins, discriminators) are **calibrated against the seeded practice labs in Unit 5**, since a threshold is a measurement, not a paper value. All four owned by Unit 5 and each ships with both a true-positive and a true-negative test (`CODING_STANDARDS.md` §7).

### ADR-D13 — JWT confusion verification signal ✅ (method resolved 2026-08-10)
**Status:** ✅ Resolved (method; thresholds calibrated in Unit 5) — D-13, Unit 5
**Resolution:** verification uses an **auth-state oracle** — an endpoint discovered in the crawl that provably distinguishes sessions: it returns one response with the analyst-supplied valid JWT and a materially different one (status and/or a content invariant) with no token. Confirmed **only if** the forged/mutated token (`alg:none`, HS/RS confusion, key reuse) elicits the *authenticated* response on that same oracle **and** that response differs from the no-token response on the stable discriminator. A bare 200 is never sufficient — the three-way comparison (none / valid / forged) is the guard.
**Doc:** `00` §9; `02` §4.4; `03` Unit 5

### ADR-D14 — Injection verification signal ✅ (method resolved 2026-08-10)
**Status:** ✅ Resolved (method; thresholds calibrated in Unit 5) — D-14, Unit 5
**Resolution:** three signals, each with a false-positive guard. **Error-based:** a DB-error signature attributable to our injected metacharacter, where a neutralized/escaped control payload produces no such error. **Time-based = dose-response:** latency must *scale* with the injected delay (e.g. `SLEEP(2s)` vs `SLEEP(4s)` ≈ a 2s gap) across ≥3 repeats measured against a per-endpoint latency baseline — a single slow response never qualifies, which is what defeats network jitter. **Boolean-differential:** an injected TRUE vs FALSE condition produces a stable, reproducible response delta (status/length/content) that flips with the boolean, and a neutral control matches the FALSE case. The dose-response requirement is the load-bearing guard on the class most prone to crying wolf.
**Doc:** `00` §9; `02` §4.4; `03` Unit 5

### ADR-D15 — IDOR verification signal ✅ (method resolved 2026-08-10)
**Status:** ✅ Resolved (method; thresholds calibrated in Unit 5) — D-15, Unit 5
**Resolution:** an authenticated crawl of **each** analyst-supplied account (D-1) **labels** which object identifiers each account legitimately owns/sees. Confirmed IDOR = the lower-privilege account A's session successfully reads/acts on an identifier labeled as **B's** and returns B's data (matched by a data discriminator), **while** the controls hold: A reading A's own object succeeds and A requesting a random non-existent id fails. The ownership labeling is the required input — without it, "A read this object" can't be distinguished from A reading its own resource, so it's the guard against the classic IDOR false positive.
**Doc:** `00` §9; `02` §4.4; `03` Unit 5

### ADR-D16 — SSRF verification signal ✅ (method resolved 2026-08-10)
**Status:** ✅ Resolved (method; thresholds calibrated in Unit 5) — D-16, Unit 5
**Resolution:** **blind = correlated OOB callback** (ADR-09) — always the preferred signal. **Non-blind** (response reflects fetched content) is confirmed only when the response contains **server-side-fetched content carrying a unique canary** the listener served for that test — never mere reflection of the submitted URL string, which is the false-positive trap. When both are possible, OOB wins. Per ADR-22, an in-sandbox socket/connect result is **never** the signal (E2B can accept-then-drop a denied egress) — reachability is always judged by the app-level/OOB signal.
**Doc:** `00` §9; `02` §3.2, §4.4; `03` Unit 5

### ADR-28 — Data access layer: Drizzle ORM + drizzle-kit migrations
**Status:** ✅ Resolved 2026-08-10 (Unit 1 build) — no prior D-## (implementation choice the specs left open)
**Alternatives considered:** Prisma (heavier runtime + its own migration engine + a generate step; a second schema source of truth); Kysely (query-builder with a first-class Better Auth adapter, but no schema-as-code/migrations — we'd hand-write DDL); raw `pg` + hand-written SQL (maximal control, minimal safety/typing). **Decision:** **Drizzle ORM** (`drizzle-orm/node-postgres`, `pg` driver) with **drizzle-kit** for migrations. Rationale: schema-as-TypeScript that doubles as the migration source and yields typed rows; first-class Better Auth Drizzle adapter (ADR-19); SQL-first migrations we own (Better Auth's programmatic migration doesn't support Drizzle); snake_case columns mapped to app casing in one place (§11). Status/vuln columns are typed with the tool-contracts discriminated unions via `$type<>()`. Custom migrations (the append-only audit triggers) are hand-written SQL registered in drizzle-kit's journal.
**Consequence:** `pnpm` must allow esbuild's build (drizzle-kit) — handled via `ignoredBuiltDependencies` + `verifyDepsBeforeRun:false` in `pnpm-workspace.yaml`. Better Auth ids are DB-generated uuids (`advanced.database.generateId:false` + `defaultRandom()` columns) so the `02` §5 uuid ERD holds.
**Doc:** `02` §5; `03` Unit 1

### ADR-29 — Crawler egress: in-browser scope enforcement outside the sandbox (v1), name-based scope
**Status:** ⚠️ Open (risk accepted for v1) — added 2026-08-11 (Unit 2 build). Tracked as **D-17** in `03` §10.
**Context:** Unit 2's crawler is passive but still sends real HTTP from a headless Chromium. It runs **outside** the E2B sandbox (ADR-22 scopes the sandbox to the active-testing burst; a crawl can span far longer and needs no payload egress control beyond scope). So for the crawl there is no network-layer egress backstop — the browser is the only enforcement point.
**Decision:** Enforce scope **inside the browser**: a Playwright **context-level** `route` handler aborts any request failing `isUrlInScope` before it leaves the browser; service workers are blocked and all WebSockets closed (both bypass page-level routing); popups are closed. Scope, seed URL, and recorded authorization are read from the scan's **target row in the DB** (never from a tool argument) — the crawler cannot be pointed wider than the authorized target. `isDangerousHost` (the SSRF host denylist) is hardened for IPv6 (loopback/ULA/link-local/IPv4-mapped).
**Known residual risk (accepted for v1):** scope is **name-based**. A host the user genuinely controls (proof-of-control, D-7) whose DNS resolves to a private/link-local/metadata IP, or a DNS-rebind between check and connect, is not caught — because there is no IP-level backstop outside the sandbox. **Mitigation deferred:** pre-resolve each new host and reject private/link-local/ULA/metadata resolved IPs, then pin with `--host-resolver-rules` so it can't rebind; or run the crawl inside the sandbox. Promoted when a target legitimately needs credentialed crawl of internal-adjacent hosts, or before any non-lab real target beyond the launch one.
**Alternatives considered:** run the crawl inside E2B from the start (heavier: E2B's 1h/24h lifecycle vs. an arbitrarily long crawl; deferred, not rejected); page-level routing (rejected — misses popups/SW/WS).
**Doc:** `03` Unit 2; `02` §10

### ADR-30 — Hypothesis `plan` stored as a jsonb column
**Status:** ✅ Resolved 2026-08-12 (Unit 3 build) — no prior D-## (a §5 schema gap surfaced building the persist slab)
**Context:** `02` §6 requires `GET /scans/:id/hypotheses` to return an **intended payload**, and §10's testers need `method`/`param`/payload-family — but the `02` §5 `hypotheses` table only had `endpoint`/`vuln_class`/`rationale`/`fingerprint`/`status`, with nowhere to persist those. **Decision:** add a single nullable **`plan` jsonb** column (over discrete typed columns). At hypothesize time it holds `{ method, param?, payloadFamily }`; the `plan` node adds `{ tool, intendedPayload }`; Unit 4/5 extend it with the concrete payload — additively, no further migration. Matches §5's existing jsonb usage (`scope_rules`, `proof_of_control`); validated at the service layer via `hypothesisPlanSchema` (stored typed via `$type<>()`). **Alternatives considered:** discrete columns (more queryable but every later plan/payload field is a new migration — rejected for churn); re-deriving the plan at test time (an extra LLM call + loses the approved determinism — rejected).
**Doc:** `02` §5, §6; `03` Unit 3

### ADR-31 — `stopped` scan lifecycle state for a pre-approval halt
**Status:** ✅ Resolved 2026-08-12 (Unit 3 build, from the Unit 3 safety review) — no prior D-##
**Context:** When `hypothesize` returns a generation error (`01` §12) or trips the daily spend stop (ADR-21), the scan run ends before the approval gate. The `02` §5.1 state machine had no state for "ended before approval," so the graph left `status` at a stale `hypothesizing` while the run had terminated — a dashboard would read an ended scan as in-progress. **Decision:** add **`stopped`** to `ScanStatus`; a `markStopped` graph node sets it on that branch, with the specific reason on the scan-runtime `hypothesizeStatus`. It is **re-runnable** (hypothesize is a replay-safe upsert, ADR-27) and **not "active"** for the concurrent-scan cap (ADR-20). Text column, so no DB migration — the union plus a §5.1 state. **Alternatives considered:** reuse `cancelled`/`rejected` (wrong semantics — those are human/authorization outcomes); interpret the `status`+`hypothesizeStatus` pair without a new state (rejected — leaves `status` misleading on its own).
**Doc:** `02` §5.1; `03` Unit 3

### ADR-32 — OOB confirmation is sweep-driven (ledger + single resume), not listener-push
**Status:** ✅ Resolved 2026-08-13 (Unit 5 build) — no prior D-## (implements ADR-D4/ADR-D16; a mechanism choice they left open)
**Context:** ADR-D4 says the OOB `interrupt()` is released "either by the OOB listener (callback) or the timeout sweep." A per-token, listener-pushed early resume interacts badly with a scan that has **multiple** pending SSRF tokens: LangGraph resumes a *thread*, not a token, so an early resume on the first callback would have to re-interrupt while the rest stay pending — a fragile multi-interrupt loop. **Decision:** the listener **only records** callbacks to the shared ledger (`OobCallbackStore`); it never resumes the graph. The **D-4 timeout sweep is the single resumer**: at the 5-min bound it resumes the paused thread once with `{ timedOut: true }`, and the `awaitOob` node reads the ledger (`wasCalledBack`) for **every** pending token, confirming those that called back and marking the rest not_confirmed. Correlation/confirmation is unchanged (a verified SSRF still requires a real correlated callback); only the *timing* changes — confirmation lands at the sweep tick rather than instantly. **Consequence:** blind-SSRF confirmation latency ≈ the D-4 bound (~5 min), which ADR-D4 already deemed acceptable. **Deferred (additive):** per-token early release on a callback (a latency optimization) and DNS-only capture at the listener (v1 captures the HTTP callback the `http://<token>.<host>` payload triggers). **Alternatives considered:** listener-pushed per-token resume (rejected for v1 — the multi-token re-interrupt fragility above); a durable long timer per token (that is exactly the Temporal dependency ADR-27 removed).
**Doc:** `02` §3.2, §4.4; `03` Unit 5; ADR-D4, ADR-D16, ADR-27

### ADR-33 — Scan-runtime service co-located in the gateway process (v1); an injected port
**Status:** ✅ Resolved 2026-08-15 (Unit 6 build) — no prior D-##
**Context:** The dashboard's approval gate (`01` §6) and scan start/cancel must *signal the durable LangGraph workflow* (`02` §6: the gateway "calls a core service or signals the workflow"). `02` §9 lists a separate **scan-runtime worker** as a deployable, but the only cross-process signal mechanism available is BullMQ — which is **Unit 7's** finding-fan-out concern and not yet built. Building a queue now purely to hop from the gateway to a worker would be building ahead (YAGNI). **Decision:** define a `ScanRuntimeService` interface (`start` / `submitApproval` / `cancel`) and **inject it into the gateway as a port**; in v1 its implementation is **co-located in the gateway process** — it holds the compiled graph + Postgres checkpointer and resumes via `Command` in-process, with long graph runs fire-and-forget (the durable checkpointer resumes a crash). The DB writes it needs (approval decision, cancel, status sync) are themselves injected ports, so `@corvid/scan-runtime` stays DB-agnostic and the service is unit-tested with a MemorySaver graph. **Because resuming a durable checkpointed thread is stateless** (any process holding the scan id + checkpointer can resume it), splitting the service into a dedicated worker later is a composition-root change behind the same interface — no call-site churn. **Consequence:** the human-approval **decision** is recorded durably in-process (owner-scoped, advisory-locked, audited) — the safety-critical part works now; the graph's reasoning/tester deps (crawl/hypothesize/plan/observe) remain external-gated (Unit 0/8) and throw a typed `InfraError` until wired. **Alternatives considered:** a BullMQ start/approval queue now (rejected — builds Unit 7 early for no v1 benefit; the durable checkpointer already provides the crash-safety a queue would); the gateway driving LangGraph inline in the request handler (rejected — a crawl/testing burst must not block an HTTP response, hence the fire-and-forget `background` port). **Deferred:** the standalone scan-runtime worker deployable + the periodic OOB-timeout sweep loop (resolver already built/tested, ADR-32) — promoted when the live testing burst (E2B + testers) lands in Unit 0/8, or when concurrent-scan throughput justifies a separate process.
**Doc:** `02` §6, §9; `03` Unit 6

### ADR-34 — Report generation triggers on scan-terminal (per-scan), via a durable BullMQ job; realtime pub/sub deferred
**Status:** ✅ Resolved 2026-08-16 (Unit 7 build) — no prior D-## (a mechanism choice ADR-17/ADR-05 left to the build)
**Context:** ADR-17/`03` Unit 7 phrase the fan-out as "a `finding.verified` triggers durable BullMQ jobs (persist the finding, trigger report generation)" plus best-effort Redis pub/sub pushing live findings to the dashboard. Two mechanism questions were left open: *when* report generation fires, and whether v1 builds the pub/sub live-push. The finding is already persisted synchronously in Postgres by the verify node (Unit 5) before any fan-out, so "persist the finding" is not a separate durable job; and a report is a whole-scan artifact with one (billed) LLM narrative call (ADR-21/23). **Decision:** (1) **Report generation is triggered once per scan when the scan reaches `reporting`, not per finding.** The graph's terminal node sets `status: 'reporting'` and ends; the gateway's `persistStatus` enqueues a durable BullMQ `report.generate` job (jobId `report-<scanId>`, idempotent) after that status is persisted; the **report-worker** (`apps/report-worker`, a real deployable per `02` §9) generates the verified-only report, stores it (JSON + rendered PDF), then sets `status: 'completed'`. So `Reporting --> Completed : report generated` (`02` §5.1) becomes literal — **`completed` means the report exists**, and killing/restarting the worker loses nothing (the finding is durable in Postgres, the job durable+idempotent in Redis). (2) **The PDF is rendered server-side at generation time** (HTML→PDF via Playwright, already a repo dep, ADR-14) and stored as `bytea`, so the gateway serves all three forms (dashboard/JSON/PDF, ADR-26) as cheap owner-scoped reads and stays thin (ADR-15/33) — a PDF-render failure degrades that one export (logged + audited), never the report or scan completion. (3) **The Redis pub/sub realtime push is deferred.** The dashboard already polls (`useScan`/`useReport`/`useFindings` with `refetchInterval`), which satisfies the DoD's "best-effort push reconciles on reload"; building an SSE transport + its cross-origin/cookie-auth story now would either ship dead code (publish with no subscriber) or a rabbit hole. **Rationale:** per-scan generation bounds LLM spend to one narrative call per scan and yields an honest whole-scan report (incl. the clean zero-finding case); triggering on `reporting` (not `completed`) makes completion mean "report ready." ADR-17's invariant is preserved — no finding is lost, and the verified-only report path (ADR-05) is unchanged (the report writer reads only the verified-findings projection). **Consequence:** report generation latency ≈ one queue hop + one LLM call + one PDF render after testing ends; a scan sits at `reporting` (visible) until the worker completes it, so a worker outage delays completion rather than losing data. **Deferred (each names its trigger):** the Redis pub/sub live-push + an SSE/WebSocket transport (promote when sub-poll latency is an observed need); per-finding durable fan-out to external consumers (promote when a real second consumer exists — YAGNI at v1). **Alternatives considered:** per-`finding.verified` report regeneration (rejected — N billed LLM calls per scan and no whole-scan narrative; the durable job would still collapse per scan anyway); rendering the PDF on-demand in the gateway (rejected — puts Chromium in the always-on thin gateway; front-loading it into the retried worker makes exports cheap DB reads); storing only JSON and regenerating the PDF per download (rejected — repeated Chromium launches on a GET).
**Doc:** `02` §1, §5.1, §6, §8; `03` Unit 7; ADR-05, ADR-17, ADR-23, ADR-26, ADR-27, ADR-33

---

## D. How to add to this log

A new judgment call that changes what the software *is* gets a new ADR here **before** the code is written — with its alternatives and rationale — plus a D-## row in `03` §10 if it stays open. Resolving an open ⚠️ item is four writes together: this entry updated with the decision, the `03` §10 row flipped, a log entry in `../progress-tracker.md`, and the originating spec doc's [Assumption] marker updated. The specs must never silently disagree with what was built.
