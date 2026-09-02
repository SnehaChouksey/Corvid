import type { ApprovalOutcome, CancelOutcome, ScanStatus } from '@corvid/tool-contracts';
import { Command } from '@langchain/langgraph';

import type { buildScanGraph } from './graph.ts';
import type { OobWaitResume } from './verify-phase.ts';

// The seam between the thin API gateway and the durable scan runtime (ADR-27). The gateway signals
// the workflow through this service (`02` §6) rather than driving LangGraph itself. In v1 the service
// is CO-LOCATED in the gateway process (ADR-33) — no queue/RPC hop yet (BullMQ fan-out is Unit 7);
// the interface preserves a later split to a dedicated scan-runtime worker.
//
// The DB writes (approval decision, cancel, status sync) are injected as ports, so the runtime stays
// db-agnostic and this service is unit-testable with a MemorySaver graph + fake ports.

type ScanGraph = ReturnType<typeof buildScanGraph>;

export interface ApprovalSubmission {
  readonly approvedHypotheses: readonly string[];
}

export interface ScanRuntimeService {
  /** Kick off a newly-created scan; runs to the approval interrupt in the background. */
  start(scanId: string, userId: string): void;
  /** Record the human decision (durably) and, only if accepted, resume testing. */
  submitApproval(scanId: string, ownerId: string, submission: ApprovalSubmission): Promise<ApprovalOutcome>;
  /** Cancel an active scan; a cancelled scan is never resumed. */
  cancel(scanId: string, ownerId: string): Promise<CancelOutcome>;
  /**
   * Resolve a scan paused at the `awaitOob` interrupt with the D-4 timeout signal, so the graph reads
   * the OOB ledger and finalizes each pending token (verified vs not_confirmed), then persists the
   * resulting status. Idempotent: a scan not paused at `awaitOob` (already resolved) is a no-op, so a
   * duplicate sweep tick can't re-resume a terminal thread. Awaits completion (unlike the fire-and-
   * forget resumes above) so the OOB sweep learns whether the resume actually happened — and RETHROWS
   * on failure so a failed resume is retried next tick rather than dropped from the paused registry.
   */
  resumeOobWait(scanId: string): Promise<void>;
}

export interface ScanRuntimeServiceDeps {
  readonly graph: ScanGraph;
  /** Persist the graph's current lifecycle state to `scans.status` (system sync — setScanStatus). */
  persistStatus(scanId: string, status: ScanStatus): Promise<void>;
  /** Advisory-locked, owner-scoped, audited approval decision (recordApprovalDecision). */
  recordApproval(scanId: string, ownerId: string, approved: readonly string[]): Promise<ApprovalOutcome>;
  /** Owner-scoped cancel (requestScanCancel). */
  requestCancel(scanId: string, ownerId: string): Promise<CancelOutcome>;
  /**
   * Run a long graph task in the background — the request handler must not block on a crawl or a
   * testing burst. The durable checkpointer means a crashed task resumes later. Injected so tests can
   * await the scheduled work; the composition root passes a fire-and-forget impl.
   */
  background(task: () => Promise<void>): void;
  /**
   * Called when a graph run pauses at the `awaitOob` interrupt (blind SSRF). The composition root
   * records the scan in the durable paused registry the OOB sweep reads (ADR-32). Optional: when
   * absent (no OOB listener wired), SSRF is never tested, so this never fires.
   */
  onOobWait?(scanId: string): Promise<void>;
  readonly logger?: { error(obj: Record<string, unknown>, msg: string): void };
}

export function createScanRuntimeService(deps: ScanRuntimeServiceDeps): ScanRuntimeService {
  const config = (scanId: string) => ({ configurable: { thread_id: scanId } });

  // Drive the graph to its next pause/end, then sync the resulting lifecycle state to the DB so the
  // dashboard reflects the workflow truthfully (CODING_STANDARDS §10). A failure is logged with safe
  // fields only (§5) and left for the durable checkpointer to resume — never rethrown into a caller.
  async function drive(scanId: string, invoke: () => Promise<unknown>): Promise<void> {
    try {
      const result = (await invoke()) as {
        readonly status?: ScanStatus;
        readonly __interrupt__?: ReadonlyArray<{ readonly value?: unknown }>;
      };
      if (result.status !== undefined) {
        await deps.persistStatus(scanId, result.status);
      }
      // If this run paused at the blind-SSRF wait, register it so the OOB sweep resumes it at the D-4
      // bound. Done AFTER persistStatus but inside the same try: a failure here is logged, not fatal —
      // the checkpointer still holds the pause, and a registry gap is a liveness (not safety) risk.
      const pausedAtOob = result.__interrupt__?.some(
        (i) => (i.value as { kind?: unknown } | undefined)?.kind === 'oob_wait',
      );
      if (pausedAtOob === true && deps.onOobWait !== undefined) {
        await deps.onOobWait(scanId);
      }
    } catch (cause) {
      deps.logger?.error(
        { err_name: cause instanceof Error ? cause.name : 'unknown', scanId },
        'scan-runtime graph run failed',
      );
    }
  }

  return {
    start(scanId, userId) {
      deps.background(() =>
        drive(scanId, () => deps.graph.invoke({ scanId, userId, status: 'authorizing' }, config(scanId))),
      );
    },

    async submitApproval(scanId, ownerId, submission) {
      // DB FIRST (invariant #1): the decision is persisted durably — approved/rejected statuses +
      // audit with the human as actor — BEFORE any test can run. Only 'accepted' resumes the graph;
      // a stale/duplicate submit hits the status guard and never re-approves. Re-submit-safe: if the
      // process dies between the record and the resume, the durable checkpoint is still paused at the
      // approval interrupt and the recorded decision lets a re-submit resume it (the status guard now
      // reads 'testing', so the record returns not_awaiting — the resume is what's retried by ops).
      const outcome = await deps.recordApproval(scanId, ownerId, submission.approvedHypotheses);
      if (outcome.kind !== 'accepted') {
        return outcome;
      }
      const approved = outcome.approved;
      deps.background(() =>
        drive(scanId, () => deps.graph.invoke(new Command({ resume: { approvedHypotheses: approved } }), config(scanId))),
      );
      return outcome;
    },

    async cancel(scanId, ownerId) {
      // No resume: a cancelled scan's paused interrupt is abandoned (never resumed), so no payload
      // fires. The DB transition is the single source of truth.
      return deps.requestCancel(scanId, ownerId);
    },

    async resumeOobWait(scanId) {
      // Idempotent guard: only resume a thread actually paused at `awaitOob`. A duplicate sweep tick
      // (or a resume that already ran but whose registry cleanup was lost) finds `next` no longer at
      // the OOB node and returns without re-invoking — a terminal thread is never re-driven.
      const snapshot = await deps.graph.getState(config(scanId));
      if (!snapshot.next.includes('awaitOob')) return;
      // Resume with the D-4 timeout signal (the only valid `awaitOob` resume — the node fails closed on
      // anything else). This drives the graph through the OOB verdicts to `reporting`. Errors PROPAGATE
      // (unlike `drive`) so the sweep can retry rather than silently drop the paused entry.
      const result = (await deps.graph.invoke(
        new Command({ resume: { timedOut: true } satisfies OobWaitResume }),
        config(scanId),
      )) as { readonly status?: ScanStatus };
      if (result.status !== undefined) {
        await deps.persistStatus(scanId, result.status);
      }
    },
  };
}
