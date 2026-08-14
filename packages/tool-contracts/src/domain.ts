// Core domain state as discriminated string unions (CODING_STANDARDS §1; scan/hypothesis
// states from 02 §5.1). Modeled so adding a state or a fifth vuln class in V2 is a compile
// error at every non-exhaustive switch, never a silent runtime gap.

export type ScanStatus =
  | 'authorizing'
  | 'crawling'
  | 'hypothesizing'
  | 'awaiting_approval'
  | 'testing'
  | 'reporting'
  | 'completed'
  | 'rejected'
  | 'cancelled'
  // The run ended before the approval gate without a terminal outcome — a generation error or the
  // daily LLM spend stop (ADR-21, `01` §12). Re-runnable: hypothesize is replay-safe; the specific
  // reason rides on the scan-runtime `hypothesizeStatus`. Not "active" for the concurrent-scan cap.
  | 'stopped';

export type HypothesisStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'tested'
  | 'confirmed'
  | 'not_confirmed';

// The four v1 vulnerability classes (00 §6). A fifth in V2 must break every non-exhaustive switch.
export type VulnClass = 'jwt' | 'ssrf' | 'injection' | 'idor';

// Verification outcome is its own type (CODING_STANDARDS §4): a test that ran and did not prove
// the exploit is `not_confirmed` — a normal domain result, NOT an error. A tooling failure is
// `error` and must never be read as a clean negative. `verified` is the only state a Finding may
// ever be constructed from. The proof-artifact shape carried on `verified` lands in Unit 5
// (Verification Engine) — deliberately not invented here.
export type VerificationOutcome =
  | { readonly kind: 'verified' }
  | { readonly kind: 'not_confirmed' }
  | { readonly kind: 'error'; readonly reason: string };

// Outcome of recording a human approval decision at the gate (Flow D, `01` §6). A domain result, not
// an exception — the caller (the scan-runtime service) branches on `kind` and the gateway maps each
// to an HTTP status. Shared between the DB layer (which produces it) and the runtime/gateway (which
// consume it), so it lives here with the other domain unions.
export type ApprovalOutcome =
  | { readonly kind: 'accepted'; readonly approved: readonly string[]; readonly rejected: readonly string[] }
  // The scan is not (or no longer) at the approval gate — a stale/duplicate submit. Never re-approves.
  | { readonly kind: 'not_awaiting' }
  // One or more submitted ids are not pending hypotheses of this scan (foreign/unknown/already-decided).
  | { readonly kind: 'invalid_hypotheses'; readonly unknown: readonly string[] };

/** Outcome of a cancel request: a terminal scan can't be cancelled; a not-owned scan is not found. */
export type CancelOutcome = 'cancelled' | 'not_found' | 'not_cancellable';

/** Exhaustiveness guard: call in a `switch` default so an unhandled member is a compile error. */
export function assertNever(value: never): never {
  // Report the runtime type only, never the value — it could be a raw target body from an untrusted
  // boundary, which must not reach a log line (§5). The stack locates the offending switch.
  throw new Error(`Unhandled union member of type ${typeof value}`);
}
