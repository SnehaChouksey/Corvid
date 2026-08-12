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

/** Exhaustiveness guard: call in a `switch` default so an unhandled member is a compile error. */
export function assertNever(value: never): never {
  // Report the runtime type only, never the value — it could be a raw target body from an untrusted
  // boundary, which must not reach a log line (§5). The stack locates the offending switch.
  throw new Error(`Unhandled union member of type ${typeof value}`);
}
