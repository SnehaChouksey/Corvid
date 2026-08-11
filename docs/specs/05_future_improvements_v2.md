# Corvid — Future Improvements — v2

**`05`** · Companion docs: [`00_project_overview.md`](00_project_overview.md), [`01_product_ux_flow_spec.md`](01_product_ux_flow_spec.md), [`02_system_architecture_spec.md`](02_system_architecture_spec.md), [`03_build_plan.md`](03_build_plan.md), [`04_design_decisions_log.md`](04_design_decisions_log.md)
**Status:** Deliberately deferred — don't build early
**Source of truth for:** what v1 intentionally does not include, and the specific observed trigger that would justify building each item.

---

## Scope of this document

This is deliberately **not** a backlog of features we didn't get to. Every item here is something that is either irrational, uneconomical, or impossible to build *correctly* before this product has proven its core claim — that it reports zero unverified findings across four classes against real targets. Ordinary deferred work (more edge-case polish, more tool coverage inside an existing class) belongs in the build plan's units, not here — putting it here would just hide scope-cutting behind a "v2" label.

Each item states *why it can't be justified now*, not just what it is. The right trigger for pulling one into active development is a concrete, observed signal — a measured precision/recall number, a real customer request, a production cost chart — never a sense that "we're bigger now." When one crosses its threshold, it re-enters through the standing process: a new ADR in `04`, a D-## row in `03` §10 if design questions remain open, and only then code.

The governing rule for this whole list: **nothing here may weaken v1's two launch-blocking invariants** — no active traffic outside recorded authorization, and no unverified finding in a report. An item that would require relaxing either is not a v2 item; it's a non-goal.

---

## A. Gated by the core claim being proven first

### A1. Additional vulnerability classes (XXE, SSTI, auth/session logic, access-control matrices)
The whole v1 bet is depth of *verification* on four classes (`00` §9), not coverage count. Adding a fifth class before the first four demonstrate zero false positives against real targets means diluting the one thing that differentiates this from a scanner. Each new class also needs its own deterministic verification signal designed — a class without one (ADR-01) doesn't belong in the product at all.
**Trigger:** the four v1 classes hit their precision/recall targets against seeded targets *and* produce a confirmed real finding (`00` §10), plus a new class for which a genuine deterministic verification signal exists — not "scanners cover it, so should we."

### A2. Autonomous remediation / fix-PR generation
Explicitly a v1 non-goal (`00` §6). Auto-fixing is a categorically different trust surface from reporting: a wrong fix modifies the customer's code, where a wrong report merely wastes attention. It only makes sense once findings are trusted enough that a human would accept a machine-proposed patch — which is exactly the trust v1 exists to earn first.
**Trigger:** verified-finding quality is high enough that customers are manually applying the exact remediation the report already describes, and asking for it as a PR — an observed behavior, not a roadmap ambition.

### A3. Continuous / pipeline-integrated scanning
v1 is a deliberate, human-gated, point-in-time run (`01` §6). Wiring scans into a pre-production pipeline changes the human-approval model (ADR-02) — a gate that pauses for days doesn't fit a CI run — and needs a story for unattended authorization that v1's deliberate recording step (ADR-03) intentionally doesn't have.
**Trigger:** customers running repeated manual scans against the same staging target on a regular cadence, asking to automate the trigger — and a designed answer for how approval works without a human present that does not weaken ADR-02/03.

### A4. Org / team tenancy (shared targets, roles, per-seat access)
v1 is single-user accounts (ADR-19): every target, scan, and finding belongs to one user, with no cross-tenant path. A team model is a different object — shared targets, who may authorize vs. who may only approve vs. who may only read, and a concurrency/spend budget shared across seats rather than per user (ADR-20/21). Better Auth's organization plugin is the intended mechanism, so this is a clean upgrade rather than a rewrite, but designing the role/permission matrix before real teams exist means guessing at it.
**Trigger:** multi-seat requests from teams already using v1 as individuals — specifically asking to share targets or split the authorize/approve/read roles — not "teams might want this."

---

## B. Gated by scale or cost data that doesn't exist yet

### B1. Multi-target campaign orchestration
v1 orchestrates one scan against one target (`00` §6). Running a campaign across many targets is a different object: shared rate budgets, per-target authorization tracking at scale, and result aggregation. Designing it before there are users running many targets means guessing at every one of those.
**Trigger:** users managing enough authorized targets that per-target scan management is the bottleneck — a countable number of targets per user, not a projection.

### B2. A dedicated event bus (Kafka/NATS) if fan-out outgrows Redis
v1 deliberately does **not** run a dedicated event bus. ADR-12's Kafka was superseded by ADR-17: finding fan-out rides the Redis already in the stack (BullMQ for durable jobs, pub/sub for the realtime feed), which is free-hostable and ample for single-target scans. This is the *inverse* of the original deferral — the heavier bus is now the deferred thing, not the default. Reintroducing one only pays once there's a genuine many-independent-consumer pattern or throughput a single Redis can't serve.
**Trigger:** production metrics showing scan/finding throughput or consumer count that a single Redis (BullMQ + pub/sub) can't comfortably serve — a real chart, not a preference. Re-enters through a new ADR that supersedes ADR-17, never by quietly adding a broker.

### B3. Concurrency / horizontal scaling of scans
v1 runs scans concurrently, each active-testing burst in its own E2B sandbox (`02` §11), but the scheduling of sandboxes and scan-runtime workers at high concurrency is left simple (D-9). Tuning it — and, at the far end, reintroducing a heavyweight durable orchestrator (Temporal or equivalent) if many-branch, hours-to-days, high-fan-out orchestration ever appears (the trigger recorded in ADR-27) — is only worth doing against a real concurrency profile.
**Trigger:** observed concurrent-scan load forcing scheduling decisions — the point at which "one container per scan, scheduled simply" measurably strains the runtime.

### B4. Cost optimization of the reasoning path
Hypothesis generation and report writing are LLM calls (`00` §11); their per-scan cost is measured in Unit 8 but not optimized (caching stable prompt prefixes, cheaper models for cheaper steps). Optimizing before there's a real cost distribution is premature.
**Trigger:** measured per-scan LLM cost against real targets showing a distribution the flat approach handles badly — real bills, not estimates.

---

## C. Gated by external ecosystem — can't, not won't

### C1. Testing targets that require capabilities the sandbox egress model forbids
The container-level egress allow-list (ADR-08) is the safety boundary and is deliberately restrictive: target host(s) + OOB listener only. Some testing scenarios (e.g. verifying an SSRF that pivots to a second in-scope internal host) would require widening egress in ways that must never be a convenience toggle.
**Trigger:** a genuinely in-scope, authorized multi-host scenario that the current egress model can't express — re-entered through a new ADR that redesigns the allow-list *without* weakening the single-target guarantee, never by loosening the existing one.

---

## How to read this list later

The right trigger for pulling an item into active development is a concrete, observed signal — a measured precision/recall pass, a confirmed real finding, a countable cluster of identical requests, a production cost chart — never a sense of momentum. Each item above names its signal. And the standing constraint overrides all of them: if promoting an item would require an active payload leaving recorded authorization or an unverified finding reaching a report, it does not get promoted — it gets refused.
