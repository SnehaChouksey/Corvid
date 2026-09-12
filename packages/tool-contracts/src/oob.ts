// The out-of-band (OOB) callback listener contract (ADR-09, D-16; path-token scheme ADR-36). The
// listener is a self-hosted service that hands out a unique token per SSRF test and records when the
// target's server-side fetch calls back to `<base>/<token>` (a single public host — no wildcard DNS).
// Two consumers build to this one interface, so they stay decoupled:
//   - the SSRF tester (`ssrf.check`, Unit 4) calls `register` to get a token + base URL to embed
//   - the SSRF verifier (Unit 5) calls `getCallback` to decide "did the exploit fire out of band?"
// Per ADR-22 an in-sandbox socket/connect result is NEVER the signal — only a correlated callback.

export interface OobRegistration {
  /** A unique, single-use token identifying this test. */
  readonly token: string;
  /** The listener's public base URL (scheme+host, no trailing slash); the payload is `<base>/<token>`. */
  readonly base: string;
}

/**
 * A recorded inbound callback — the provenance the verifier and the report carry. `receivedAt` lets
 * the gate bound the callback to the D-4 window; `sourceIp` is what an analyst triages ("a fetch from
 * this address retrieved the token"). Safe scalars only — never request headers or body (§5).
 */
export interface OobCallback {
  /** Epoch ms the listener observed the callback. */
  readonly receivedAt: number;
  /** Best-effort source address of the callback (safe metadata for triage). */
  readonly sourceIp?: string;
}

export interface OobListener {
  /** Register a per-test token with the listener for a scan; returns the token + callback host. */
  register(scanId: string): Promise<OobRegistration>;
  /** The correlated inbound callback recorded for this token, or null if none — never a socket result. */
  getCallback(token: string): Promise<OobCallback | null>;
}
