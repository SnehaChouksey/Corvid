import type { ApprovalOutcome, CancelOutcome, ScanStatus } from '@corvid/tool-contracts';
import { Command } from '@langchain/langgraph';

import type { buildScanGraph } from './graph.ts';

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
  readonly logger?: { error(obj: Record<string, unknown>, msg: string): void };
}

export function createScanRuntimeService(deps: ScanRuntimeServiceDeps): ScanRuntimeService {
  const config = (scanId: string) => ({ configurable: { thread_id: scanId } });

  // Drive the graph to its next pause/end, then sync the resulting lifecycle state to the DB so the
  // dashboard reflects the workflow truthfully (CODING_STANDARDS §10). A failure is logged with safe
  // fields only (§5) and left for the durable checkpointer to resume — never rethrown into a caller.
  async function drive(scanId: string, invoke: () => Promise<unknown>): Promise<void> {
    try {
      const result = (await invoke()) as { readonly status?: ScanStatus };
      if (result.status !== undefined) {
        await deps.persistStatus(scanId, result.status);
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
  };
}
