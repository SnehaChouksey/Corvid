# Corvid — Coding Standards

**Coding standards** · Companion docs: [`specs/00_project_overview.md`](specs/00_project_overview.md), [`specs/01_product_ux_flow_spec.md`](specs/01_product_ux_flow_spec.md), [`specs/02_system_architecture_spec.md`](specs/02_system_architecture_spec.md)
**Status:** Spec v1 · **Last updated:** August 2026
**Source of truth for:** how code in this repo is written — types, structure, error handling, and the safety and verification invariants the architecture in `02` depends on.

---

## 0. Philosophy

The spec docs never let a decision default silently — anything not decided upstream is marked **[Assumption]** with reasoning instead of quietly baked in. Code follows the same discipline: types make invalid states unrepresentable, comments explain reasoning instead of narrating syntax, and errors are handled deliberately instead of swallowed.

Two product facts shape almost every rule below, and both are unusual enough to state plainly:

1. **A single unverified finding collapses the product** (`00` §11). The verification path — the deterministic gate, the OOB correlation — is the code that must stay most legible, most testable, and most obviously non-LLM. If a reviewer can't tell at a glance that the gate is deterministic, the code is wrong even if it works.
2. **This software sends active attack payloads at live systems.** Every boundary is a safety boundary: recorded authorization, sandbox egress, per-target rate limits, test credentials. A bug here isn't a defect, it's unauthorized traffic. Code at these boundaries is written to fail *closed*.

**Language & repo posture (ADR-18, resolved 2026-08-10):** **everything is TypeScript, strict mode** — dashboard (Next.js), API gateway (Hono), LangGraph agent core + durable scan-runtime worker (LangGraph.js), every MCP tool server, and the OOB listener. It is **one monorepo on pnpm workspaces + Turborepo**: `apps/*` for deployables, `packages/*` for shared code, with the MCP tool contracts as the load-bearing shared package (§2). All-TS keeps the additive-only tool contract a single imported package rather than a generated cross-language artifact. One caveat carried from ADR-18: LangGraph's TS SDK is younger than its Python one — verify against its current docs before coding (§12), and surface a capability gap rather than working around it.

---

## 1. Types

- **Strict TypeScript, no escape hatches.** `strict: true` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; no `any` — a genuinely-unknown shape is `unknown`, narrowed by a schema parse. If a type error is inconvenient, fix the type, don't loosen the checker. One `tsconfig` base extended per workspace package (ADR-18).
- **Schema-validate at every trust boundary.** For this system the concrete boundaries are: **LLM output** (a hypothesis the model proposes is a *suggestion* until parsed — never trusted as structured data raw), **MCP tool arguments and results** (the agent-to-tool contract), **HTTP responses from the target** (untrusted by definition — it's the thing under test), **OOB callback payloads**, **REST request bodies from the dashboard**, and **environment variables** (§9).
- **Discriminated unions over string flags** for anything with real states: scan status (`authorizing | crawling | hypothesizing | awaiting_approval | testing | reporting | completed | rejected | cancelled`), hypothesis status (`pending | approved | rejected | tested | confirmed | not_confirmed`), vuln class, verification outcome. Switch exhaustively with a `never`/exhaustiveness check, so adding a fifth vuln class in V2 is a compile error everywhere it isn't handled, not a silent runtime gap.
- **The verification outcome is its own type, and "verified" is a narrow, provable state.** Model it so that a `Finding` can only be constructed from a `Verified` verification result — not from an observation, not from a hypothesis, not from an LLM string. Make "unverified thing becomes a finding" unrepresentable rather than merely avoided.
- **Named exports only** (TS). No default exports — they rename silently on import and hurt cross-package search.

---

## 2. Repo structure

`02` §1 settles the shape: four responsibility boundaries (workflow, agent reasoning, finding fan-out, tool servers) that must not blur, plus a deliberately thin gateway. The structure exists to keep that true:

- **One monorepo, `apps/*` + `packages/*` (ADR-18).** `apps/*` holds the deployables (dashboard, gateway, agent core + scan-runtime worker, each tool server, OOB listener); `packages/*` holds shared code — the MCP tool contracts/schemas package first among them. pnpm workspaces for dependency resolution, Turborepo for `build`/`test`/`lint`/`typecheck` task pipelines and caching. A dependency belongs to the narrowest workspace that needs it, never hoisted to the root "to be safe."
- **The API gateway is thin.** Hono handlers do transport concerns only — auth resolution, input schema parse, calling a core service or starting/resuming the scan runtime, shaping the response. Business logic that could be tested without an HTTP server does not live in a handler.
- **The agent core embeds no vuln-specific logic.** LangGraph nodes reason and route to tools; they never craft a JWT mutation or a SQLi payload inline. That logic lives in the tool servers. A node that knows how to exploit a specific class is a structural violation of ADR-11.
- **Each tool server is an independent module with a versioned contract.** `crawler`, `http-send`, `jwt-mutator`, `ssrf-checker`, `injection-fuzzer`, `idor-tester` — each independently deployable and testable. Nothing outside a tool server constructs a raw request to the target.
- **Tool contracts live in one shared package** (input/output schemas), imported by both the agent core and each server. Never hand-duplicated on both sides.
- **The one HTTP path to the target is `http.send`.** No tester opens its own socket; all target traffic flows through the shared send tool so dedup, the rate posture, **path-level scope (ADR-24)**, and audit happen in exactly one place (§5). Path scope lives here because the sandbox firewall (host-level) structurally can't see it.
- **The sandbox is E2B (ADR-22), created per active-testing burst.** The egress allow-list (`denyOut: all` + `allowOut: [target, OOB]`) is set at `Sandbox.create` from the scan's scope — never hand-assembled per call. The sandbox is created after approval and torn down when testing ends; it must not be held open across the approval pause or an OOB wait (E2B lifetime cap). Never treat a successful socket/connect inside the sandbox as reachability — E2B can accept-then-drop a denied egress (§5, §7).
- **The dashboard never imports agent/tool/workflow code** other than shared schemas. A shared type moves to the schema package; it's never a reach into the core.

---

## 3. Modularity, aligned to the architecture

- **The verification gate is one module, deterministic, with no LLM import in scope.** Classify → synchronous check or OOB check → `verified` true only if the exploit provably fired. It is the product's core invariant; keep it isolated, exhaustively tested, and structurally incapable of consulting a model.
- **Within the agent core, keep these separate**: consuming the crawl map (`perceive`), proposing hypotheses (`hypothesize`, the one LLM call in the reasoning path), selecting tool + payload (`plan`), and interpreting observations. Distinct nodes, not one function — "the model returned malformed hypotheses" must stay visibly distinct from "the tool failed" and from "the verification said no."
- **Authorization and egress scope are computed once, from one source.** The target's scope rules produce both the workflow's authorization check and the sandbox's egress allow-list (`02` §7). One derivation, two enforcement points — never two hand-maintained copies that can drift, because a drift here means testing a host the analyst didn't authorize.
- **Rate posture and dedup are `http.send` invariants, not caller etiquette.** Enforce them inside the shared send tool so no tester can forget a flag and bypass them (D-2, D-10).
- **The two identities the OOB flow correlates never blur.** A per-test OOB token maps to exactly one hypothesis in one scan. A callback that can't be correlated to a live token is logged and discarded, never charged to "some SSRF probably worked."
- **Graph nodes and BullMQ jobs are idempotent and re-runnable — this is load-bearing, not good-practice (ADR-27).** A LangGraph node **re-runs from its start** when a scan resumes after a crash (there is no Temporal exactly-once to lean on), and every finding-fan-out job may be retried by BullMQ (ADR-17). Both must be safe to run twice for the same entity: an OOB registration keyed on the token, a **send guarded by `http.send` dedup** (this is what makes a replayed payload safe — our substitute for exactly-once), a finding persist keyed on hypothesis id, a report-trigger that no-ops if already generated. A node that sends a payload and then does more work must be written so a replay can't double-send. The realtime pub/sub path is the exception by design: best-effort, carries nothing that must survive.

---

## 4. Error handling

- **No empty catch blocks, ever.** Every catch handles, rethrows with context, or logs enough to debug — never swallows.
- **"Not confirmed" is a domain outcome, not an exception.** A test that runs and doesn't prove the exploit is a normal, successful result that marks the hypothesis `not_confirmed`. Model it in the verification return type so no layer can convert it into a thrown error, and — the dangerous direction — so a *tooling error* can never be silently read as a clean negative. A network timeout mid-test is `error`, not `not_confirmed`; conflating them is how a real vulnerability gets missed.
- **Typed errors over string matching.** Distinguish at minimum: a target-side error (429/5xx from the target — informative, not our bug), a tool/infra failure (the sandbox, the OOB listener, the LLM), an authorization/scope refusal (a hard stop, never retried into scope), and a verification negative (a domain outcome, above). Actual error types or a `Result`-style return — never inspecting `error.message` for a substring.
- **A partial failure must never look like success.** The dangerous cases here are specific: a payload that was sent but whose observation was lost (did it fire?), a verification that ran but whose proof artifact failed to persist (a finding with no proof is not a finding), an OOB callback received but not correlated. Prefer an order of writes where a crash leaves *detectable* inconsistency rather than a silent wrong finding, and log enough to reconcile.
- **Authorization and egress failures are terminal and loud.** A scope refusal or a denied egress is surfaced, audited, and — for a denied egress — flags the hypothesis that attempted it (`01` §12). Never retried, never downgraded to a warning, never worked around in code.

---

## 5. Safety & security discipline

This section is load-bearing — the software sends active payloads at live targets and holds credentials to them.

- **Every request is authenticated and owner-scoped (ADR-19).** Resolve the Better Auth session to one `users.id`, then scope every query by owner — a target/scan/finding not owned by the caller is a 404, not a 403 (no cross-tenant existence leak). Tenant isolation lives in the data layer, never in a UI check; a query that can return another user's row is a review-blocking defect. There is no shared-secret or service-level path that reaches a user's data without their identity.
- **Authorization requires proof-of-control, not assertion (D-7).** Recording authorization for a target must carry evidence the authenticated user controls it. "The user clicked Authorize" is not sufficient — the whole target-facing safety story rests on this being real (ADR-03).
- **Platform abuse controls fail closed (ADR-20).** Per-user API rate limits and the per-user concurrent-scan cap are enforced server-side, refuse with a typed retry-after / cap-reached outcome (never a 500, never a silent drop), and the concurrency cap is checked at workflow start — the one bound on sandbox/worker exhaustion. These are distinct from the per-target rate posture (D-2): that protects the target, this protects Corvid.
- **LLM spend is recorded at the call site and gated (ADR-21).** Both LLM call sites (hypothesis generation, report writing) record per-call cost where the call happens — not as a best-effort audit — and a daily hard-stop (global + per-user) refuses further LLM-billed calls once tripped, as a typed domain outcome the scan surfaces. A new LLM call path that skips cost recording is a review-blocking defect. The gate degrades reasoning throughput only; it can never touch the non-LLM verification gate.
- **Authorization is checked at two layers, computed from one scope.** The workflow refuses to start without recorded authorization for the exact current scope; the sandbox egress allow-list is derived from that same scope. Neither trusts the other to be correct (ADR-03/08). A code change that touches one and not the other is a review-blocking defect.
- **Sandbox egress is the real boundary; keep it enforceable (E2B, ADR-22).** All target traffic goes through a tool server inside the E2B sandbox whose firewall allow-list is `denyOut: all` + `allowOut: [target, OOB]`, derived from scope. No code path lets the agent core reach the network directly — that's what makes the allow-list mean something. A denied egress is recorded, not retried. Egress is **host-level**; finer scope is `http.send`'s job (ADR-24). And never read "the socket opened" as reachability — E2B can accept-then-drop a blocked destination, so proof is always an application-level/OOB signal (this is the ADR-01 rule, reinforced).
- **The verification gate never imports an LLM client.** Structurally, not by discipline: the module that decides `verified` has no path to a model. A reviewer must be able to confirm this by imports alone.
- **Everything is audited, at the action.** Every crawl request, hypothesis, approval/rejection, payload sent, observation, and verification outcome writes an append-only audit record with actor + timestamp + detail, at the point it happens — not as a best-effort afterthought. A new action path that skips the audit write is a defect (ADR-16).
- **Secrets and target-sensitive data never reach a log line — structurally.** Test credentials, the encryption key, and raw target response bodies (which may contain sensitive data from the app under test) are excluded from logs, error reports, and monitoring. Log structured metadata only: scan id, hypothesis id, vuln class, endpoint, outcome. Never interpolate a secret or a raw body into a message string — no redact layer walks message text (this is a known failure mode: an allow-listed error field carrying free text still leaks).
- **Test credentials are least-privilege, encrypted at rest, decrypted transiently.** The IDOR accounts (D-1) and any target auth are scoped to the target, encrypted in the database, decrypted only in-memory at the moment of use, never returned from a function that outlives the call.
- **OOB tokens are single-use and correlated.** One token, one hypothesis, one scan. An uncorrelated callback proves nothing and is discarded.
- **A security & safety review runs at the end of every build unit** (`03`), not once at the end. Given the active-testing surface, its findings are fixed before the next unit builds on top.

---

## 6. Comments

- **Explain *why*, not *what*.** If a reader needs a comment to know what a line does, the code needs better names.
- **Comment the non-obvious**: why a verification signal is sufficient proof ("a correlated OOB callback is the only server-side-fetch evidence — response is opaque"), a safety constraint's reasoning ("egress derived from scope, not configurable per call — ADR-08"), a platform/target quirk. Nothing else.
- **Proportional, not padded.** A one-line reason gets one line.
- **No commented-out code left behind.** Delete it — version control remembers.

---

## 7. Testing

- **The verification gate is tested with both true positives and true negatives.** For every class: a seeded-vulnerable case must produce a verified finding, *and* a seeded non-vulnerable case must produce no finding. The false-positive test is as important as the true-positive one — it's the product's whole claim (`03` Unit 5 DoD).
- **Each tool server is testable in isolation, without the loop.** Replay a fixed hypothesis through the JWT Mutator (or any tester) against a fixture and against a practice target, with no LangGraph run — this is what tool isolation (ADR-11) buys, and the tests must exercise it.
- **Each LangGraph node is unit-testable against a fixture** — no live target, no network. Hypothesis generation is tested against canned (including malformed) LLM output: does `perceive`/`hypothesize`/`plan` do the right thing, including refusing garbage?
- **The safety invariants have explicit tests.** The workflow refuses to start without authorization; the sandbox denies a deliberate out-of-scope egress and audits it; an unverified observation cannot reach the findings store. These are asserted, not assumed.
- **Cross-tenant isolation is tested by direct call (ADR-19).** User A's token must not read or act on user B's targets, scans, hypotheses, findings, or audit records — proven with direct API calls, never inferred from the UI hiding a button. This is the platform's confidentiality claim; a gap is a breach, not a bug.
- **Abuse controls and the spend gate are tested firing (ADR-20/21).** The per-user API rate limit and concurrent-scan cap refuse excess with the typed outcome (not a 500); the LLM spend hard-stop refuses a call once tripped and records cost even when the LLM output fails to parse. Test the realistic mistake (lowering a stop below its alert, forgetting to gate a new LLM call site), not only the symmetric case.
- **No test sends an unauthorized or unbounded payload.** Tests run against seeded practice targets or fixtures, inside the same egress/rate discipline as production. A test is not exempt from the safety boundary.
- **The durable scan runtime is tested for durability (ADR-27)** — a scan-runtime restart mid-pause (approval `interrupt()`, OOB `interrupt()`) resumes from the Postgres checkpoint at the same node without losing state, and a node forced to crash mid-run re-runs safely (dedup prevents a double-send). The OOB-timeout sweep is tested to resolve a stuck interrupt to "not confirmed" at the D-4 bound.

---

## 8. Tool contracts (MCP)

- **One schema per tool, defined once in the shared contract package**, imported by the agent core and the server. Never hand-written on both sides.
- **Contracts are additive-only once published.** The agent depends on a tool's exact shape; changing an existing input/output is a compatibility decision, not a refactor. Add fields or version deliberately.
- **A tool never decides "verified."** Tools emit structured observations; the verification gate (§5) decides. A tool that returns a boolean "vulnerable" is a design error — it's usurping the gate.

---

## 9. Config & secrets

- **Every environment variable validated against a schema at process startup.** Fail immediately and loudly on a missing or malformed value — never proceed with `undefined` and surface it three layers deep, least of all on a safety-relevant value (an unset egress config must fail the boot, not default to open).
- **No secrets in code or committed files.** The test-credential encryption key, LLM API keys, and any target credentials live in the environment/secret store (D-9).
- **Fail closed on anything safety-relevant.** A missing authorization config, an unresolvable scope, or an unconfigured egress restriction must stop the scan, never widen access.

---

## 10. Dashboard & frontend

Visual direction is not dictated here — design work owns it. These engineering requirements hold regardless:

- **The two safety-critical surfaces are correctness-critical, not just UX.** The authorization step (`01` §3) and the approval gate (`01` §6) must capture exactly what the analyst authorized/approved — a mis-recorded scope or an approval attributed to the wrong hypothesis is a safety bug. Treat these like money paths.
- **Every `01` §12 state is a real deliverable** — unauthorized-target block with a reason, empty surface, pending-OOB, not-confirmed, denied-egress flag, zero-finding clean report. Error and edge states around active testing are where analyst trust is won or lost.
- **Live feed and lifecycle state reflect the workflow truthfully.** A scan shown as "testing" that's actually paused, or a finding shown before it's verified, breaks the core promise on the screen. The dashboard renders verified findings only in the report, matching the backend invariant.
- **Responsive, real focus/hover/active states, `prefers-reduced-motion` respected, skeletons over bare spinners** where content shape is known.

---

## 11. Naming & file conventions

- `kebab-case` for files/folders, `PascalCase` for components and types, `camelCase` for functions/variables. Don't mix within a module.
- Database columns stay `snake_case` (matching `02` §5); the mapping to the app's casing happens once, in the data layer, not ad hoc per query.
- Barrel/`index` files only at a module's public boundary.

---

## 12. Dependencies & external libraries

- **Install packages through `pnpm add`** (ADR-18), scoped to the workspace that needs it (`pnpm --filter <pkg> add …`), never by hand-typing a version number into a `package.json` — a version remembered from training data may already be stale.
- **Verify usage against official documentation before writing code against it**, not after review flags it. This matters most for the fast-moving pieces of this stack: the **MCP specification** (transport and tool contracts), **LangGraph.js** (StateGraph/nodes + the `interrupt()`/`Command` durability APIs and the Postgres checkpointer — the durability spine, ADR-27), **E2B** (sandbox network/egress + lifecycle APIs), and **Playwright**.
- **Don't add a dependency for what a few lines do.** Follow the solving-problems ladder — reuse what's here, then the stdlib, then the platform, then an installed dep, then minimum new code.

---

## 13. Logging

- **All logging goes through one shared structured logger.** Never `console.*`/`print` in product code.
- **Standard fields bound where the ids first exist:** `scan_id` on everything in a scan, `hypothesis_id` through the test/verify path, `vuln_class` and `endpoint` on tool calls, `actor` on every audited action.
- **The log is not the audit trail.** Audit records are durable, append-only, and a deliverable (§5, ADR-16); logs are operational. Don't conflate them, and never let a raw response body or secret into either (§5).

---

## 14. Migrations

- **Every migration is backward-compatible with the revision it replaces** (expand, deploy, contract). Any non-additive step (drop, rename, narrowing a type, adding `NOT NULL` without a default) is split: additive migration first, then the deploy that stops using the old shape, then the contracting migration later.
- **Migration filenames say what the migration does** — prefer the effect (`0003_findings_store_proof_artifact`) over the mechanism. A random generated name is worthless in a `git log` or a failed deploy that names one file.
- **The audit log and findings tables are append-mostly and referential** — a migration that could orphan a finding from its hypothesis or scan, or that could drop audit history, gets extra scrutiny; those tables are the accountability record.
- **The LangGraph checkpoint store is production data (ADR-27).** A paused scan (approval or OOB `interrupt()`) is a serialized graph state in Postgres. A code change to the graph's shape or state schema can make an **in-flight checkpoint unresumable** — so change the graph the same way as an expand/contract migration: tolerate old checkpoints across the overlap, or drain paused scans first. Back the store up (a lost checkpoint is a stuck scan), and rely on the OOB-timeout sweep as the backstop that no paused scan lingers forever.
