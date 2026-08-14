import type { OobCallback, SsrfObservation } from '@corvid/tool-contracts';

import { DEFAULT_SEVERITY, notConfirmed, type VerifyResult } from './types.ts';

// SSRF verification (D-16). Blind SSRF is confirmed ONLY by a correlated out-of-band callback: the
// target's server-side fetch reached `<token>.<oob-host>` and the self-hosted listener recorded a
// callback for THAT unique, single-use token (ADR-09). The token correlation is the listener's job;
// the gate consumes the recorded callback (its provenance carried into the proof). Two false-positive
// traps are structurally excluded:
//   - a reflected input (the app echoing our URL string) is never the signal — only a real inbound
//     callback the listener served counts, and the observation never carries reflected content;
//   - an in-sandbox socket/connect result is never the signal (E2B can accept-then-drop a denied
//     egress, ADR-22) — the callback originates at the listener, out of band, not from the response.
// If the payload never went out (out-of-scope/deduplicated) there is nothing to confirm. If it went
// out but no correlated callback was recorded, that is a normal `not_confirmed` (a timeout is a
// domain outcome, never an error). The proof states what is PROVEN — "a server-side fetch from
// <sourceIp> retrieved the unique single-use token" — not the stronger claim that it was definitively
// the application host, which the evidence can't support (the sourceIp is what an analyst triages).
// Non-blind canary confirmation is an additive follow-up gated on the tester emitting that signal.
// Deterministic, no LLM.

// A callback must be temporally correlated to the test that sent the payload: the sweep resolves the
// wait at the D-4 bound (5 min), so an honest callback is recorded within it. A generous cap over
// that absorbs clock skew between the sandbox worker (sentAt) and the listener box (receivedAt) while
// still rejecting a stale callback that surfaced only because a sweep worker was down for hours — the
// error direction that matters here is toward a false NEGATIVE, never a false positive.
export const MAX_CALLBACK_LATENCY_MS = 10 * 60 * 1000;

export function verifySsrf(observation: SsrfObservation, callback: OobCallback | null): VerifyResult {
  const { param, oobToken, sent, sentAt } = observation;

  if (!sent) {
    return notConfirmed('SSRF payload was not sent (out-of-scope or deduplicated) — nothing to confirm out of band');
  }

  if (callback === null) {
    // The payload went out but no correlated callback was recorded. A clean domain negative, not an
    // error: the server-side fetch either didn't happen or didn't reach us.
    return notConfirmed('no correlated OOB callback recorded for this token — not confirmed');
  }

  const latencyMs = callback.receivedAt - sentAt;
  if (latencyMs > MAX_CALLBACK_LATENCY_MS) {
    // A callback exists but is too far from the send to be attributed to this test (e.g. surfaced
    // after a long sweep outage). Fail toward not_confirmed rather than a stale confirmation.
    return notConfirmed('OOB callback is outside the correlation window for this test — not confirmed');
  }

  return {
    kind: 'verified',
    severity: DEFAULT_SEVERITY.ssrf,
    proof: {
      summary: `Blind SSRF confirmed on parameter "${param.name}": a server-side fetch${
        callback.sourceIp !== undefined ? ` from ${callback.sourceIp}` : ''
      } retrieved the unique single-use OOB token ${Math.max(latencyMs, 0)}ms after the payload was sent — proof the injected URL was fetched server-side, not merely reflected.`,
      signals: {
        param: param.name,
        oobToken,
        outOfBandCallback: true,
        latencyMs: Math.max(latencyMs, 0),
        ...(callback.sourceIp !== undefined ? { sourceIp: callback.sourceIp } : {}),
      },
    },
  };
}
