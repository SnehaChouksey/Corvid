# Corvid — Project Overview

**`00`** · Companion docs: [`01_product_ux_flow_spec.md`](01_product_ux_flow_spec.md), [`02_system_architecture_spec.md`](02_system_architecture_spec.md)
**Status:** Spec v1 · **Last updated:** August 2026
**Source of truth for:** what we're building, for whom, and why. Technical implementation lives in `02`; the analyst-facing flow lives in `01`.

---

## 1. One-line summary

Corvid is an autonomous application-security agent that tests authorized web applications the way a human penetration tester does — it hypothesizes where a vulnerability likely exists, actively tests that hypothesis, and reports a finding only after a deterministic check proves the exploit actually fired.

---

## 2. The problem

Automated security is split between two failure modes, and nobody occupies the middle.

- **Rule-based scanners match patterns** — a package version, a response header, a regex on a body — without ever checking whether the thing is *exploitable*. They produce high false-positive volumes that teams learn to ignore, which is the worst outcome a security tool can have: it trains its users to dismiss it. They also miss anything that requires reasoning about the specific application: a JWT `alg` confusion on a custom auth flow, or a blind SSRF that only reveals itself through an out-of-band network callback.
- **Manual penetration testing reasons correctly** — a human forms a hypothesis about the app's actual logic, tests it, and confirms the exploit — **but does not scale.** It is expensive, slow, and available only in point-in-time engagements.

**The gap:** nobody automates the *reasoning loop* — hypothesize, test, verify — while keeping the verification step deterministic. Existing "AI security" tools are mostly thin LLM wrappers that let a model *opine* that something is vulnerable, which reproduces the false-positive problem with a more confident voice.

---

## 3. The solution / core insight

Split the problem along the line where each half is strong. **The reasoning (what to test) is agentic; the verification (is it real) is deterministic engineering.** An LLM is good at hypothesizing where a custom auth flow might confuse `alg: none`, or which parameter smells like a server-side fetch — and bad at being trusted about whether the exploit fired. So the agent proposes and tests, and a non-LLM check gets the final word: a finding is reported only when a deterministic signal (a correlated out-of-band callback, a provable auth-state transition, a differential response) confirms the exploit triggered.

This is the wedge: **zero unverified findings.** Not "high-confidence" findings — *verified* ones, each shipping with a reproducible trigger.

---

## 4. Target users

**Primary:** Security analysts and application-security engineers running authorized testing against their own or in-scope applications — practice labs, staging environments, and authorized bug-bounty targets — who want a pentester's reasoning at machine scale without a pentester's false-positive tax.

**Secondary (later, not v1):** Development teams wanting continuous authorized testing wired into a pre-production pipeline.

---

## 5. Product pillars (non-negotiable in v1)

1. **Verify, never guess.** A finding is reported only after a deterministic check proves the exploit fired. The LLM never gets the final word.
2. **Humans authorize active steps.** Passive crawling proceeds autonomously; anything that sends a live test payload to a target waits for explicit human approval.
3. **No target is touched without recorded authorization** — enforced in the workflow, not just in policy.
4. **Everything is audited** — every action against a target is logged with actor, timestamp, and payload, because the audit trail is itself a deliverable a real security tool must produce.

---

## 6. V1 scope (MVP)

- The full agentic loop — perceive → hypothesize → plan → act → observe → verify → loop — running against a single authorized target, orchestrated durably so it can pause for human approval or an out-of-band callback and resume without losing state.
- **Four vulnerability classes, done with real verification** (§9), not twenty done shallowly:
  - JWT algorithm / key confusion
  - SSRF, including blind SSRF verified via out-of-band callback
  - SQL / NoSQL injection
  - IDOR (insecure direct object reference)
- A **human approval gate**: the agent generates hypotheses, a human reviews and approves which ones may be actively tested, and only approved hypotheses send a payload.
- A **sandboxed execution environment** per scan, whose network egress is allow-listed to exactly the authorized target and the system's own out-of-band listener.
- A **self-hosted out-of-band callback listener** for confirming blind vulnerabilities that the HTTP response alone cannot prove.
- A **dashboard**: scan configuration, a live findings feed, the approval gate UI, and a generated report built from verified findings only.
- A **full audit log** of every action, per scan.

## Non-goals (v1)

- **Scanning any target without recorded, explicit authorization** — this is a hard technical constraint (§5, and enforced in `02`), not a policy preference.
- **Broad shallow coverage of every CVE / vuln class.** v1 covers four classes with real verification; breadth is a deliberate V2 concern (`05`).
- **Autonomous remediation** (opening fix PRs). v1 reports to a human; auto-fix is a possible future extension, not in scope.
- **Fully autonomous active testing with no human in the loop**, on any target.

## V2 candidates (explicitly deferred — see `05`)

- Additional vulnerability classes (XXE, SSTI, auth/session logic, access-control matrices) beyond the initial four.
- Autonomous remediation / fix-PR generation.
- Continuous / pipeline-integrated scanning.
- Multi-target campaign orchestration.

---

## 7. Guiding design principles

These constrain every architectural decision in `02` — when a call is close, these are the tie-breakers.

1. **Verify, don't guess.** A finding is only ever reported after a deterministic check proves the exploit fired (e.g. an OOB server actually received a correlated callback). The LLM never decides whether something is a vulnerability.
2. **Humans authorize irreversible or active steps.** Passive crawling proceeds autonomously; anything that sends an actual test payload to a live target waits for explicit human approval.
3. **Durability over cleverness.** The scan is a durable, pausable, resumable graph (LangGraph + a Postgres checkpointer, ADR-27) anywhere a step might wait minutes to days (human approval, OOB callback). Scan state is checkpointed to Postgres, never held in memory or a fragile in-process timer.
4. **Least-privilege network access by default.** Every scan runs in a sandbox whose egress is allow-listed to exactly the authorized target and the system's own OOB listener — enforced at the infrastructure level, not just in application logic.
5. **Tool isolation.** Each testing capability (crawler, JWT mutator, SSRF checker, injection fuzzer) is an independently deployable, independently testable tool server. The agent core embeds no vulnerability-specific logic.
6. **Everything is audited.** Every action against a target is logged with actor, timestamp, and payload — for accountability and as a first-class deliverable.

---

## 8. Tech stack & rationale

Every row is a decision with reasoning of record in `04`; the ones still open or assumed are flagged there and tracked as D-## rows in `03` §10.

| Layer | Technology | Why this, specifically |
|---|---|---|
| Language & repo | TypeScript (strict) monorepo — pnpm workspaces + Turborepo | Every component is TS, so the additive-only MCP tool contract stays a single shared package instead of a cross-language artifact; one type system/test runner/lint across the repo, with Turborepo task caching (ADR-18) |
| Dashboard | Next.js + shadcn/ui | Scan config, live findings feed, approval-gate UI |
| Auth | Better Auth | Platform sign-in + sessions; every target/scan/finding scoped to an owning user, no cross-tenant path (ADR-19). Single-user in v1; org/team is a V2 plugin upgrade |
| API gateway | Hono | Thin, fast gateway; no business logic lives here by design |
| Durable scan runtime | LangGraph + Postgres checkpointer | The scan lifecycle *is* the reasoning graph, durably checkpointed: the human-approval pause and OOB wait are `interrupt()`s that survive crashes/deploys and resume days later, on the Postgres already in the stack — no separate orchestration service (ADR-27; Temporal considered and dropped, ADR-07) |
| Agent reasoning | LangGraph | Explicit, inspectable state machine (perceive→hypothesize→plan→act→observe→verify) rather than one opaque prompt chain — every transition is a named, testable, loggable node |
| Tool interface | MCP | Uniform contract between the agent core and each testing capability; lets vuln-class logic evolve and version independently of the agent |
| Browser automation | Playwright | Handles JS-rendered SPAs and multi-step auth flows a raw HTTP crawler would miss |
| Finding fan-out | Redis — BullMQ + pub/sub | Decouples "a finding was verified" from its consumers without a separate hosted bus: BullMQ (Redis-backed) for durable async work (persist finding, trigger report), Redis pub/sub for the best-effort realtime dashboard feed. Chosen over Kafka for free-hostability at v1 scale (ADR-17) |
| Primary datastore | PostgreSQL | Scans, targets, hypotheses, findings, audit log — relational integrity matters (a finding must reference a real hypothesis and scan) |
| Cache / queue / bus | Redis | Crawl frontier queue, dedup cache, and the BullMQ job queue + pub/sub fan-out (one instance, several roles) |
| Sandbox runtime | E2B (per-testing-burst microVM) | Firecracker microVM with a firewall egress allow-list (`denyOut: all` + `allowOut: [target, OOB]`) — the egress boundary enforced by the platform, not application code; TS SDK, free credits (ADR-22) |
| LLM gateway | OpenRouter | Hypothesis generation + report writing through one gateway; model-agnostic, returns per-call cost the spend cap reads (ADR-23) |
| OOB verification | Self-hosted callback listener (Interactsh-style) | Blind SSRF/XXE cannot be verified from the HTTP response alone; a correlated external callback is the only real proof |

---

## 9. Target vulnerability classes (v1)

Each class was chosen because it *needs* an agentic approach, a deterministic verification signal, or both — not because it was easy.

| Class | Why it fits this approach | Deterministic verification signal |
|---|---|---|
| JWT algorithm / key confusion | Requires reasoning about the specific auth flow, not a static signature check | A provable authenticated-state transition using a forged/mutated token |
| SSRF (including blind) | Verification requires an out-of-band loop, not response inspection | A correlated callback received on the OOB listener for a unique per-test token |
| SQL / NoSQL injection | Classic hypothesize → fuzz → deterministically verify pattern | Error-based, time-based (statistically bounded), or boolean-differential signal |
| IDOR | Requires comparing behavior across two authenticated sessions of different privilege | One session provably reading/acting on another's object |

---

## 10. Success metrics (v1)

- **Detection precision and recall** against practice targets with seeded, known vulnerabilities.
- **Zero unverified findings** in any generated report — the defining metric; a single unverified finding is a launch-blocking defect, not a quality slip.
- **At least one confirmed finding on a real, authorized target** (practice lab or in-scope bounty program) — ground truth that this isn't a simulated result.
- **Scan duration and infrastructure cost per target.**

---

## 11. Risks & external dependencies

- **A single unverified finding collapses the entire premise.** The whole product is "we don't cry wolf." The verification gate (§7.1) is therefore the code that must stay most deterministic, most testable, and most legible — see `CODING_STANDARDS.md`.
- **Authorization is a safety-critical boundary.** Pointing active testing at an out-of-scope host is the failure mode that ends a project like this. It is enforced in the workflow and at the sandbox egress layer, defense-in-depth, never in policy alone.
- **Sandbox egress restriction must actually hold.** The container-level allow-list is the last line between "authorized testing" and "unauthorized traffic to the internet." A bug in application logic must not be able to widen it.
- **OOB verification depends on the target actually calling back.** Blind SSRF confirmation requires the target's own infrastructure to make the correlated request; a missing callback within the timeout is "not confirmed," never "confirmed." The timeout policy is an open decision (D-4).
- **LLM cost and non-determinism in the reasoning path.** Hypothesis generation and report writing are LLM calls; their cost per scan and their variance both need bounding. On free hosting an uncapped loop is a real runaway, so a daily spend hard-stop (global + per-user) gates the reasoning path (ADR-21); because the verification gate is non-LLM, a spend stop degrades throughput, never finding integrity. The reasoning being non-deterministic is fine by design — the verification being non-deterministic is not, and never is.
- **Platform self-protection, not just target protection.** Corvid must not be abusable by its own users: access is authenticated and tenant-isolated (ADR-19), authorization requires proof-of-control so a user can't aim it at a target they don't own (D-7), the API is rate-limited with a per-user concurrent-scan cap so one account can't exhaust the sandbox pool (ADR-20), and LLM spend is capped (ADR-21). These are distinct from the target-facing safety and are first-class v1 scope, not hardening afterthoughts.
- **Rate-limiting against a live target.** Authorized testing can still trip a target's own WAF/IDS or degrade it; the per-target rate strategy is an open decision (D-2).
- **Practice targets and a real authorized target must be lined up early.** The v1 success metrics (§10) depend on seeded practice labs and at least one in-scope real target — external lead time, started in Unit 0 (`03`).

---

## 12. Glossary

| Term | Meaning |
|---|---|
| **Scan** | One authorized run of the full agentic loop against one target, with a lifecycle owned by a durable workflow. |
| **Target** | An authorized web application, with recorded scope rules and an authorization timestamp. |
| **Hypothesis** | A candidate vulnerability the agent proposes (vuln class + endpoint + rationale) before any active test is sent. |
| **Finding** | A hypothesis that has been actively tested and **deterministically verified**; the only thing a report may contain. |
| **Verification** | The deterministic, non-LLM check that decides whether an exploit provably fired. |
| **OOB (out-of-band) callback** | A network request the target makes to the system's own listener, correlated by a unique per-test token — the only proof of a blind vulnerability. |
| **Approval gate** | The human review step where an analyst approves which hypotheses may be actively tested. |
| **Sandbox** | The per-scan ephemeral container whose network egress is allow-listed to the target + OOB listener only. |
| **Audit log** | The per-scan record of every action taken, by actor (agent or human), with timestamp and payload. |
| **Tool server (MCP)** | An independently deployable testing capability (crawler, JWT mutator, SSRF checker, injection fuzzer) exposed to the agent through the MCP contract. |

---

## 13. Open questions still to validate (not decisions to keep refining on paper)

As of the 2026-08-10 pass, **every specs-level decision is resolved** (see `03` §10 and `04`). What remains open is deliberately *not* a decision — it's numbers that need real data, which the specs' own discipline says not to fix on paper:

- **Verification-signal thresholds** — the *methods* are fixed (JWT three-way oracle, injection dose-response timing, IDOR labeled ownership, SSRF OOB/canary; D-13–D-16); only the numeric thresholds (sample counts, delay margins) are calibrated against the seeded labs in Unit 5.
- **Abuse-limit and LLM-spend values** — mechanisms fixed (D-11/D-12); conservative config defaults raised once real usage/cost is measured (Unit 8).

_Resolved this pass:_ verification signal methods (D-13–D-16), rate posture (D-2, backoff on WAF signals), severity = **CVSS 3.1** (D-3), OOB timeout = **5 min + audit-note late callbacks** (D-4), proof-of-control = **DNS TXT / `.well-known`** (D-7), fingerprint scheme (D-10), target credentials analyst-supplied (D-1), hosting = **E2B + managed Postgres/Redis + OOB box, no Temporal** (D-9), all-TypeScript on OpenRouter (ADR-18/23), **durable runtime = LangGraph checkpointer, Temporal removed** (ADR-07 ⛔ → ADR-27).

---

## 14. Related documents

- **`01_product_ux_flow_spec.md`** — every analyst-facing screen, state, and journey, from authorizing a target to reading the report.
- **`02_system_architecture_spec.md`** — components, sequence flows, data-flow diagrams, data model, and the technical decisions that implement everything above.
- **`03_build_plan.md`** — the units v1 is built in, each retiring one kind of risk, and the register of open decisions.
- **`04_design_decisions_log.md`** — how the design reached its current state, decision by decision.
- **`05_future_improvements_v2.md`** — what v1 deliberately excludes, and the trigger that would justify each item.
