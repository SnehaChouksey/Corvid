import type { HypothesizeOutcome, PerceivedSurface } from '@corvid/agent-core';
import type { CrawlerMapOutput, ScanStatus } from '@corvid/tool-contracts';
import { Annotation } from '@langchain/langgraph';

// The durable scan graph's state (ADR-27). Keyed by scan id (= LangGraph thread_id). `status`
// mirrors the `02` §5.1 state machine so the persisted checkpoint always reflects a real lifecycle
// state. LangGraph nodes re-run from their start on resume, so nodes must be idempotent (§3):
// perceive is pure, hypothesize upserts by fingerprint, plan is idempotent.
//
// Checkpoint discipline (§14): these channels are serialized to Postgres. Adding/removing a channel
// changes the checkpoint schema — an in-flight paused scan from an older shape may not resume, so
// change this the way you'd run an expand/contract migration. (No in-flight checkpoints exist yet.)

/** Last-write-wins reducer for a single-valued channel. */
function lastWriteWins<T>(): { reducer: (current: T, incoming: T) => T } {
  return { reducer: (_current: T, incoming: T): T => incoming };
}

export const ScanState = Annotation.Root({
  scanId: Annotation<string>,
  /** The scan owner, carried so the reasoning nodes attribute spend/cost without re-deriving it. */
  userId: Annotation<string>,
  status: Annotation<ScanStatus>,
  /** The crawl map produced by the crawl node and consumed by perceive. */
  crawlMap: Annotation<CrawlerMapOutput | null>({ ...lastWriteWins(), default: () => null }),
  /** The normalized attack surface produced by perceive and consumed by hypothesize. */
  surface: Annotation<PerceivedSurface | null>({ ...lastWriteWins(), default: () => null }),
  /** The hypothesize node's outcome, which the router branches on (generated → plan, else → end). */
  hypothesizeStatus: Annotation<HypothesizeOutcome['kind'] | null>({
    ...lastWriteWins(),
    default: () => null,
  }),
  // Hypotheses the human approved at the gate. Last-write-wins: the approval decision replaces it.
  approvedHypotheses: Annotation<string[]>({ ...lastWriteWins(), default: () => [] }),
});

export type ScanStateType = typeof ScanState.State;

/** Payload surfaced by the approval `interrupt()` — what the dashboard shows at the gate. */
export interface ApprovalRequest {
  readonly kind: 'approval_request';
  readonly scanId: string;
}

/** The human's decision, supplied via `new Command({ resume })` to release the pause. */
export interface ApprovalDecision {
  readonly approvedHypotheses: readonly string[];
}
