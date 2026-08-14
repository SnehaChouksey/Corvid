import type { SsrfObservation } from '@corvid/tool-contracts';

import { DEFAULT_SEVERITY, notConfirmed, type VerifyResult } from './types.ts';

// SSRF verification (D-16). Blind SSRF is confirmed ONLY by a correlated out-of-band callback: the
// target's server-side fetch reached `<token>.<oob-host>` and the self-hosted listener recorded a
// callback for THAT unique, single-use token (ADR-09). The token correlation is the listener's job;
// the gate consumes the boolean result. Two false-positive traps are structurally excluded here:
//   - a reflected input (the app echoing our URL string) is never the signal — only a real inbound
//     callback the listener served counts, and the observation never carries reflected content;
//   - an in-sandbox socket/connect result is never the signal (E2B can accept-then-drop a denied
//     egress, ADR-22) — the tester emits no socket signal, only the token + whether the payload was
//     sent. `calledBack` originates at the listener, out of band, not from the target response.
// If the payload never went out (out-of-scope/deduplicated) there is nothing to confirm. If it went
// out but no callback arrived within the D-4 wait bound, that is a normal `not_confirmed` (a timeout
// is a domain outcome, never an error). Non-blind canary confirmation (server-fetched content
// carrying a unique canary) is an additive follow-up gated on the tester emitting that signal.
// Deterministic, no LLM.

/**
 * Decide the SSRF verdict from the tester's observation and the OOB listener's correlated-callback
 * result. `calledBack` MUST come from the listener's `wasCalledBack(token)` (out of band) — never
 * from a socket result or a reflected response body.
 */
export function verifySsrf(observation: SsrfObservation, calledBack: boolean): VerifyResult {
  const { param, oobToken, sent } = observation;

  if (!sent) {
    return notConfirmed('SSRF payload was not sent (out-of-scope or deduplicated) — nothing to confirm out of band');
  }

  if (!calledBack) {
    // The payload went out but no correlated callback arrived within the D-4 wait bound. A timeout is
    // a clean domain negative, not an error: the server-side fetch either didn't happen or didn't reach us.
    return notConfirmed('no correlated OOB callback for this token within the wait bound (D-4) — not confirmed');
  }

  return {
    kind: 'verified',
    severity: DEFAULT_SEVERITY.ssrf,
    proof: {
      summary: `Blind SSRF confirmed on parameter "${param.name}": the target's server-side fetch called back to the unique OOB token the listener served for this test — proof the injected URL was fetched server-side, not merely reflected.`,
      signals: {
        param: param.name,
        oobToken,
        outOfBandCallback: true,
      },
    },
  };
}
