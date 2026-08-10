// OOB-timeout sweep (D-4, ADR-27) — stub for Unit 1. A blind-SSRF/XXE hypothesis waits at an OOB
// `interrupt()` for a correlated callback; if none arrives within the D-4 bound (5 min default),
// the sweep resumes the paused scan and marks the hypothesis "not confirmed" so a scan never hangs
// forever. Unit 5 wires this to the OOB listener and resumes with a timeout `Command`; here we
// provide (and test) the pure deadline logic that decides which threads have timed out.

/** Default OOB wait before a paused hypothesis is resolved to "not confirmed" (D-4). */
export const OOB_TIMEOUT_MS = 5 * 60 * 1000;

export interface PausedOobThread {
  /** LangGraph thread id (= scan id) paused at an OOB interrupt. */
  readonly threadId: string;
  /** When the OOB interrupt began waiting (epoch ms). */
  readonly interruptedAt: number;
}

/** Thread ids whose OOB wait has reached the timeout bound and must be resolved to "not confirmed". */
export function findTimedOutThreads(
  threads: readonly PausedOobThread[],
  nowMs: number,
  maxAgeMs: number = OOB_TIMEOUT_MS,
): readonly string[] {
  return threads.filter((thread) => nowMs - thread.interruptedAt >= maxAgeMs).map((t) => t.threadId);
}
