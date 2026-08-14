import type { SsrfObservation, TesterObservation, VulnClass } from '@corvid/tool-contracts';

// Shared shapes for the act → observe → verify phase (Unit 5). Kept in one file so both the graph
// (orchestration) and the state channels reference them without a cycle. The deterministic gate
// itself lives in @corvid/verify (no LLM, ADR-01); the graph calls it in-process.

/**
 * One tester's OBSERVATION for an approved hypothesis (the act + observe step). The gate decides
 * `verified` later (§8) — a tester never does. `observation` is null when the tester could not send
 * (out-of-scope oracle / dedup / unsupported placement): a clean not_confirmed, never a fabricated
 * signal or a wrong-location test read as a clean negative.
 */
export interface ObservedHypothesis {
  readonly hypothesisId: string;
  readonly observation: TesterObservation | null;
}

/** A VERIFIED finding the gate produced, handed to the injected persistence port (insertFinding). */
export interface VerifiedFinding {
  readonly hypothesisId: string;
  readonly vulnClass: VulnClass;
  /** The technique/payload family that fired — a safe descriptor, never a raw body/secret (§5). */
  readonly payload: string;
  /** The deterministic proof summary (why the exploit provably fired). */
  readonly proof: string;
  /** CVSS 3.1 base score + vector (D-3, ADR-D3). */
  readonly severity: string;
}

/** A blind-SSRF observation awaiting a correlated OOB callback, resolved at the D-4 timeout bound. */
export interface PendingOob {
  readonly hypothesisId: string;
  readonly observation: SsrfObservation;
}

/** Surfaced by the OOB-wait `interrupt()` — the tokens the paused scan is waiting on (D-4). */
export interface OobWaitRequest {
  readonly kind: 'oob_wait';
  readonly scanId: string;
  readonly tokens: readonly string[];
}

/**
 * Supplied via `new Command({ resume })` to release the OOB wait. The D-4 timeout sweep resumes with
 * `timedOut: true` at the 5-minute bound; the graph then reads the listener's ledger to decide each
 * pending token (verified vs not_confirmed).
 */
export interface OobWaitResume {
  readonly timedOut: boolean;
}
