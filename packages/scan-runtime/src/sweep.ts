import type { OobWaitResume } from './verify-phase.ts';

// OOB-timeout sweep (D-4, ADR-27). A blind-SSRF hypothesis waits at the `awaitOob` `interrupt()` for
// a correlated callback; if none arrives within the D-4 bound (5 min default), this sweep resumes the
// paused scan with the timeout signal so the graph resolves each pending token to "not confirmed" and
// the scan never hangs. A tooling/wait timeout is a deliberate domain resolution, never a hang and
// never an error (§4). The pure deadline logic (`findTimedOutThreads`) is separated from the resolver
// so it stays trivially testable; the resolver is driven by injected ports so it needs no live graph.
//
// Late callback (ADR-D4): a callback that lands AFTER the scan has closed is audited by the listener
// (`oob.callback`) but can NEVER become a finding — the only path that mints an SSRF finding is the
// `awaitOob` node, which won't run again once the scan is terminal. So a late callback is an
// informational audit note by construction, never an after-the-fact edit to a verified-only report.

/** Default OOB wait before a paused hypothesis is resolved to "not confirmed" (D-4). */
export const OOB_TIMEOUT_MS = 5 * 60 * 1000;

export interface PausedOobThread {
  /** LangGraph thread id (= scan id) paused at the OOB interrupt. */
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

/** The injected side-effecting ports the sweep drives; the real impl wires the checkpointer + graph. */
export interface OobSweepPorts {
  /** Paused OOB threads with when each began waiting (real impl queries the Postgres checkpointer). */
  listPausedOob(): Promise<readonly PausedOobThread[]>;
  /** Resume a paused thread with the timeout signal (real impl invokes the graph with a `Command`). */
  resume(threadId: string, resume: OobWaitResume): Promise<void>;
  /** Append an audit note for the timeout resolution (ADR-16); the sweep acts as a system actor. */
  audit?(entry: { readonly scanId: string; readonly action: string }): Promise<void>;
  /** Safe-fields logger for a resume failure; never receives raw error messages (§5). */
  readonly logger?: { error(obj: Record<string, unknown>, msg: string): void };
  /** Override the D-4 bound (defaults to `OOB_TIMEOUT_MS`). */
  readonly maxAgeMs?: number;
}

/**
 * Resolve every OOB wait that has reached the D-4 bound: resume the paused scan with `timedOut:true`
 * so the graph reads the listener ledger and finalizes each pending token, then audit the timeout.
 * Returns the thread ids actually resolved. One thread's resume failure never aborts the sweep — the
 * unresolved thread simply stays paused and is retried on the next tick (a not-resumed wait is safe;
 * a crashed sweep that abandons the rest is not).
 */
export async function sweepOobTimeouts(ports: OobSweepPorts, nowMs: number): Promise<readonly string[]> {
  const due = findTimedOutThreads(await ports.listPausedOob(), nowMs, ports.maxAgeMs);
  const resolved: string[] = [];
  for (const threadId of due) {
    try {
      await ports.resume(threadId, { timedOut: true });
      if (ports.audit !== undefined) await ports.audit({ scanId: threadId, action: 'oob.timeout' });
      resolved.push(threadId);
    } catch (cause) {
      ports.logger?.error(
        { err_name: cause instanceof Error ? cause.name : 'unknown', threadId },
        'oob sweep resume failed; will retry next tick',
      );
    }
  }
  return resolved;
}
