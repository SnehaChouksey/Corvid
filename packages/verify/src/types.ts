import type { VulnClass } from '@corvid/tool-contracts';

// @corvid/verify is the deterministic verification gate (ADR-01) — the architectural heart of the
// product's "zero false positives" promise. It consumes the testers' observations and decides
// `verified` with a plain, non-LLM check. The boundary is STRUCTURAL: this package's dependency list
// carries no `@corvid/llm`, so verification can never "ask a model" whether an exploit fired. A
// verified result carries a human-readable, reproducible proof of WHY it fired.

/** The deterministic proof a verified finding carries — what fired and the discriminators used. */
export interface VerificationProof {
  /** One-line human-readable statement of what the gate proved. */
  readonly summary: string;
  /** The concrete signals the decision rested on — safe scalars only, never a raw body/secret (§5). */
  readonly signals: Readonly<Record<string, string | number | boolean>>;
}

/**
 * The gate's verdict. `verified` ONLY when the exploit provably fired (carries the proof + severity).
 * Anything else is `not_confirmed` (a normal domain outcome — the test ran, the exploit didn't fire)
 * or `error` (a tooling failure — never read as a clean negative, CODING_STANDARDS §4).
 */
export type VerifyResult =
  | { readonly kind: 'verified'; readonly proof: VerificationProof; readonly severity: string }
  | { readonly kind: 'not_confirmed'; readonly reason: string }
  | { readonly kind: 'error'; readonly reason: string };

// Conservative default CVSS 3.1 base score + vector per class (D-3, ADR-D3). v1 uses a per-class
// default; the exact per-finding refinement is calibrated with the labs (Unit 8). The Critical/High
// band is derived from the score at read time, not stored.
export const DEFAULT_SEVERITY: Readonly<Record<VulnClass, string>> = {
  injection: '9.8 CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
  jwt: '8.1 CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:N',
  ssrf: '8.6 CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:L/A:N',
  idor: '6.5 CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N',
};

/** A verdict a verify function can return when the observation cannot be evaluated (never verified). */
export function notConfirmed(reason: string): VerifyResult {
  return { kind: 'not_confirmed', reason };
}
