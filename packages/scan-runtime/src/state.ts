import type { ScanStatus } from '@corvid/tool-contracts';
import { Annotation } from '@langchain/langgraph';

// The durable scan graph's state (ADR-27). Keyed by scan id (= LangGraph thread_id). `status`
// mirrors the `02` §5.1 state machine so the persisted checkpoint always reflects a real lifecycle
// state. LangGraph nodes re-run from their start on resume, so nodes must be idempotent (§3).

export const ScanState = Annotation.Root({
  scanId: Annotation<string>,
  status: Annotation<ScanStatus>,
  // Hypotheses the human approved at the gate. Last-write-wins: the approval decision replaces it.
  approvedHypotheses: Annotation<string[]>({
    reducer: (_current, incoming) => incoming,
    default: () => [],
  }),
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
