// The out-of-band (OOB) callback listener contract (ADR-09, D-16). The listener is a self-hosted
// service (Avinash's half of Unit 5) that owns a wildcard DNS/HTTP domain: it hands out a unique
// token per SSRF test and records when the target's server-side fetch calls back to
// `<token>.<host>`. Two consumers build to this one interface, so they stay decoupled:
//   - the SSRF tester (`ssrf.check`, Unit 4) calls `register` to get a token + host to embed
//   - the SSRF verifier (Unit 5) calls `wasCalledBack` to decide "did the exploit fire out of band?"
// Per ADR-22 an in-sandbox socket/connect result is NEVER the signal — only a correlated callback.

export interface OobRegistration {
  /** A unique, single-use token identifying this test. */
  readonly token: string;
  /** The listener host; the payload references `<token>.<host>`. */
  readonly host: string;
}

export interface OobListener {
  /** Register a per-test token with the listener for a scan; returns the token + callback host. */
  register(scanId: string): Promise<OobRegistration>;
  /** Whether a correlated inbound callback for this token has been observed by the listener. */
  wasCalledBack(token: string): Promise<boolean>;
}
