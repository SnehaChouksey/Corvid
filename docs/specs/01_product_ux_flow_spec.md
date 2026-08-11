# Corvid — Product UX Flow

**`01`** · Companion docs: [`00_project_overview.md`](00_project_overview.md), [`02_system_architecture_spec.md`](02_system_architecture_spec.md)
**Status:** Spec v1 · **Last updated:** August 2026
**Scope:** every analyst-facing screen, state, and journey. Product rationale lives in `00`; technical implementation of these flows lives in `02`.

---

## 0. How to read this doc

Each flow is written as a numbered sequence of **analyst-visible states**, not implementation steps. Where a flow depends on a technical mechanism (durable workflow pause, OOB correlation, sandbox egress), it's named but not detailed — see `02`. The single most important UX fact in this document, from which most of the rest follows: **the analyst is a co-operator of an active security tool, not a spectator.** Two states carry disproportionate weight — the authorization step (`§3`) and the approval gate (`§6`) — because they are where a human takes responsibility for traffic hitting a live target.

---

## 1. Flow map

| Flow | Trigger | Where it happens |
|---|---|---|
| A. Authorize a target & define scope | Analyst adds a target | Dashboard |
| B. Configure & start a scan | Authorized target exists | Dashboard |
| C. Passive crawl & surface mapping | Scan starts | Autonomous (surfaced live in dashboard) |
| D. Hypothesis review & approval gate | Candidates generated | Dashboard (approval UI) |
| E. Active testing & live findings feed | After approval | Autonomous (surfaced live in dashboard) |
| F. Out-of-band verification wait | A blind hypothesis is under test | Background (status surfaced in the feed) |
| G. Report review & export | All hypotheses resolved | Dashboard |
| H. Audit trail review | Any time, per scan | Dashboard |

---

## 2. Personas & entry points

Every persona is an **authenticated user** (Better Auth, ADR-19); the dashboard has no anonymous surface, and a user only ever sees their own targets, scans, and findings — another user's resources don't exist to them (`02` §6–7).

- **New analyst, no target yet:** signs in → authorizes a target (Flow A) → configures a scan (Flow B). Cannot reach any active-testing surface until a target is authorized.
- **Returning analyst, scan in progress:** opens the dashboard → the scan is paused at the approval gate (Flow D) waiting on them, or streaming findings (Flow E).
- **Returning analyst, reviewing results:** opens a completed scan → report (Flow G) and audit trail (Flow H).

---

## 3. Flow A — Authorize a target & define scope

This is the safety-critical entry point. Nothing downstream — no crawl, no payload — can happen for a target that hasn't passed through here.

1. **Add target** screen: the analyst enters the target base URL and scope rules (in-scope hosts/paths, explicit out-of-scope exclusions).
2. **Authorization confirmation with proof-of-control (D-7 resolved, ADR-D7):** the analyst places a Corvid-issued token in a **DNS TXT record** on the target domain **or** a file at **`/.well-known/`** on the target, and Corvid **fetches and verifies it** before authorization is recorded (actor + timestamp). This can't be faked by clicking — it's the control that stops an authenticated user aiming Corvid at a target they don't own. Until verified, the target sits in an **Unauthorized** state and cannot be scanned.
3. On confirmation, the target moves to **Authorized**, stamped with who authorized it and when. This record is what the workflow checks before it will start (`02`).

**Empty state to avoid:** a target that looks ready to scan but has no recorded authorization. The "Start scan" affordance is not merely disabled — it states *why* ("Authorization not recorded for this scope") and links back to step 2.

**Edge case — scope edited after authorization:** any change to scope rules invalidates the prior authorization and returns the target to **Unauthorized**. Widening scope must never inherit an old approval.

---

## 4. Flow B — Configure & start a scan

1. **Scan config** screen (Authorized target only): select which of the four vuln classes (`00` §9) to test, the per-target rate posture (D-2), and **the target credentials the run uses (D-1, resolved)** — the analyst supplies all of them here: a login for the crawler to map authenticated surface, a sample JWT for the JWT tester, and the two accounts at different privilege for IDOR. Corvid stores them encrypted, scoped to the scan, and never provisions accounts on the target itself. Credentials are optional per need — a scan with none simply tests only the unauthenticated surface.
2. **Start scan** → a durable scan workflow is created; the target's authorization is re-checked at workflow start, not just trusted from the UI.
3. The analyst is taken to the **live scan view**, which shows the scan's current lifecycle state (`02` §5.1): `Authorizing → Crawling → Hypothesizing → AwaitingApproval → Testing → Reporting → Completed`.

**Edge case — authorization lapsed between config and start:** the workflow refuses to leave `Authorizing`, the scan surfaces `Rejected — no valid scope`, and the analyst is routed back to Flow A. No crawl begins.

---

## 5. Flow C — Passive crawl & surface mapping

Autonomous — no approval needed, because passive crawling sends no test payloads (`00` §7.2).

1. The live scan view shows crawl progress: pages discovered, endpoints and parameters mapped, auth flows detected.
2. The crawl runs inside the per-scan sandbox, egress-restricted to the authorized target (`02` §7); nothing here reaches the target outside recorded scope.
3. When the attack surface is mapped, the scan advances to **Hypothesizing** and the agent proposes candidate vulnerabilities.

**Edge case — crawl finds nothing testable:** the scan reports an empty attack surface and completes with no findings rather than manufacturing hypotheses to look busy.

---

## 6. Flow D — Hypothesis review & approval gate

The human-authorizes-active-steps pillar (`00` §7.2) made concrete. **This is a hard pause** — the workflow suspends and holds no thread; it simply waits for the analyst's signal (`02` §3.3).

1. The **approval gate** screen lists every generated hypothesis: vuln class, endpoint, the agent's rationale ("why the agent thinks this is worth testing"), and the exact test it intends to send.
2. The analyst **approves or rejects each hypothesis** — individually, so a risky test can be declined without blocking the safe ones. Nothing is pre-approved.
3. On submit, the workflow resumes and actively tests **only the approved hypotheses**. Rejected ones are recorded (with the analyst as actor) and never tested.

**Edge case — analyst never returns:** the scan stays paused indefinitely without consuming resources (durable workflow, `00` §7.3). No test fires on a timeout; silence is not consent.

**Edge case — approve nothing:** valid. The scan proceeds to report with zero findings. Approving a subset is the norm, not the exception.

---

## 7. Flow E — Active testing & live findings feed

1. For each approved hypothesis, the agent routes to the matching tool server (JWT mutator, SSRF checker, injection fuzzer, IDOR tester), which sends the test payload to the target through the shared HTTP tool — inside the sandbox, cost- and rate-bounded.
2. Each observation runs through the **deterministic verification gate** (`02` §4.4). A hypothesis becomes a **Finding only when the check proves the exploit fired**; otherwise it's marked *not confirmed* and never surfaces as a finding.
3. **Verified findings stream into the live feed** in real time (pushed via Redis pub/sub, `02` ADR-17): vuln class, endpoint, severity, and the stored proof artifact. The durable record is in PostgreSQL, so a dropped live update self-corrects on reload — the feed is a convenience, never the source of truth.

**Edge case — a test errors or the target rate-limits us:** the observation is recorded, the hypothesis is marked *not confirmed* (not *failed silently*), and the run continues with the remaining approved hypotheses. A tooling error must never read as a clean negative.

**Edge case — dedup:** a hypothesis fingerprint already tested in this scan is skipped rather than re-sent (`02`, Redis dedup cache).

---

## 8. Flow F — Out-of-band verification wait

The flow that specifically justifies a durable workflow over a simple job queue (`02` §3.2).

1. For a blind hypothesis (blind SSRF/XXE), the SSRF checker registers a **unique token** with the OOB listener and sends a payload referencing it.
2. The target's HTTP response proves nothing on its own; the feed shows the hypothesis as **Pending OOB confirmation**, not confirmed and not dismissed.
3. If a **correlated callback** arrives on the listener for that token, the hypothesis is deterministically **confirmed** and becomes a finding.
4. If no callback arrives within the timeout (**5 minutes** default, D-4), the OOB-timeout sweep resumes the paused hypothesis and marks it **not confirmed** — the scan never hangs waiting forever. A callback that lands *after* the scan closed is recorded in the audit trail as an informational note, never auto-added to the closed report.

---

## 9. Flow G — Report review & export

1. When every hypothesis is resolved (tested or timed out), the scan enters **Reporting**. The report writer builds the report from **verified findings only** — it has no access to raw, unverified agent reasoning (`00` §7.1, `02`).
2. **Report screen:** each finding with its vuln class, **CVSS 3.1 severity (score + vector, D-3)**, affected endpoint, the exact payload used, and the **reproducible proof** (the OOB callback record, the auth-state transition, the differential response).
3. Export the report in any of three forms from the same verified source (ADR-26): read it **in the dashboard**, download **JSON** (machine-readable findings + proof artifacts, for tooling), or download **PDF** (the shareable pentest-style document). A scan with zero verified findings produces a clean report that says so — an honest empty result, never padded with maybes.

**Edge case — an analyst looks for a hypothesis that isn't in the report:** rejected and not-confirmed hypotheses are visible in the scan detail and audit trail (Flow H), just not in the report. The report is the verified-only artifact; the audit trail is the complete record.

---

## 10. Flow H — Audit trail review

1. **Audit screen (per scan):** every action taken during the scan, in order — crawl requests, hypotheses generated, approvals/rejections (with the human actor), payloads sent, observations, verification outcomes — each with actor and timestamp.
2. This is both an accountability surface and a deliverable (`00` §7.6). No action is exempt from it; the agent and the human are both actors in the same log.

---

## 11. Screen inventory

| Screen | Primary purpose |
|---|---|
| Targets list | All targets with authorization status (Unauthorized / Authorized) |
| Add / edit target | Base URL, scope rules, authorization recording (Flow A) |
| Scan config | Vuln-class selection, rate posture, analyst-supplied target credentials — crawl login, JWT sample, IDOR pair (Flow B, D-1) |
| Live scan view | Lifecycle state, crawl progress, live findings feed |
| Approval gate | Per-hypothesis approve/reject with rationale + intended payload (Flow D) |
| Findings feed / detail | Verified findings streaming in; per-finding proof (Flow E/F) |
| Report | Verified-only findings, severity, payload, proof; export as JSON + PDF (Flow G, ADR-26) |
| Audit trail | Complete per-scan action log with actor + timestamp (Flow H) |
| Scan history | Past scans per target, status, finding counts |

---

## 12. Empty, error & edge-case states catalog

- **Proof-of-control not satisfied** → the target can't be authorized; the screen states what proof is needed (D-7), never letting a bare assertion through (Flow A).
- **Concurrent-scan cap reached** → starting another scan is refused with a clear "you have N scans running, wait or cancel one" message (ADR-20), not a generic failure.
- **API rate limit hit** → a typed retry-after response surfaced as "you're going too fast, try again shortly," never a 500 or a silent no-op (ADR-20).
- **Target not authorized** → scan affordance disabled *with a reason*, linking to the authorization step (Flow A). Never a bare disabled button.
- **Scope edited after authorization** → target returns to Unauthorized; prior approval discarded (Flow A).
- **Authorization lapsed between config and start** → workflow refuses to start; scan shows `Rejected — no valid scope` (Flow B).
- **Empty attack surface after crawl** → scan completes with no findings, stated plainly (Flow C).
- **Analyst never acts on the approval gate** → scan stays paused indefinitely, no resource drain, no test fires (Flow D).
- **Analyst approves nothing** → valid; scan reports zero findings (Flow D).
- **Test errors / target rate-limits us** → observation recorded, hypothesis *not confirmed*, run continues; never a silent clean negative (Flow E).
- **Duplicate hypothesis fingerprint** → skipped, recorded as deduped (Flow E).
- **Blind hypothesis, no OOB callback within 5 min (D-4)** → the timeout sweep marks it *not confirmed*, scan proceeds; never hangs (Flow F).
- **OOB callback arrives after the scan closed** → recorded in the audit trail as an informational note; never retroactively added to a closed report (D-4 resolved, ADR-D4).
- **Sandbox egress denies an out-of-scope request the agent attempted** → the attempt is blocked at the container level, recorded in the audit trail as denied, and the hypothesis that produced it is flagged for analyst attention (a hypothesis that tried to leave scope is itself a signal).
- **Zero verified findings overall** → clean report stating no verified vulnerabilities were found; the audit trail still shows everything attempted (Flow G/H).
- **LLM hypothesis generation fails / returns malformed output** → the scan surfaces a generation error and pauses for the analyst rather than proceeding on garbage; "the model returned nothing usable" is visibly distinct from "no hypotheses exist."

---

## 13. Open UX questions to validate before build

- **Approval-gate granularity (Flow D)** — per-hypothesis approve/reject is the v1 shape; whether analysts want class-level or endpoint-level bulk approval is a post-first-use question, not a pre-build one.

_Resolved this pass:_ authorization mechanism = **DNS TXT / `.well-known` proof-of-control, Corvid-verified** (Flow A, D-7/ADR-D7); severity presentation = **CVSS 3.1 score + vector** (Flow G, D-3/ADR-D3); late OOB callback = **audit note, never re-opens a closed report** (Flow F, D-4/ADR-D4).
