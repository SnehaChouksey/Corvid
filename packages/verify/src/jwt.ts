import type { JwtObservation } from '@corvid/tool-contracts';

import { DEFAULT_SEVERITY, notConfirmed, type VerifyResult } from './types.ts';

// JWT confusion verification (D-13). The auth-state oracle is an endpoint that provably distinguishes
// sessions: it returns one response with the analyst-supplied valid token and a materially different
// one with no token. A forged/mutated token is CONFIRMED only if it elicits the *authenticated*
// response on that oracle AND that response differs from the no-token response on a stable
// discriminator (status + a content invariant). A bare 200 is never sufficient — the three-way
// none/valid/forged comparison is the whole guard against the false positive. Deterministic, no LLM.

/** Two response signals are "materially the same" when both status and body hash agree. */
function sameResponse(a: JwtObservation['noToken'], b: JwtObservation['noToken']): boolean {
  return a.status === b.status && a.bodyHash === b.bodyHash;
}

export function verifyJwt(observation: JwtObservation): VerifyResult {
  const { noToken, validToken, oracleUrl } = observation;

  // Precondition: the oracle must actually distinguish authenticated from unauthenticated. If a valid
  // token and no token look identical, there is no three-way baseline and nothing can be confirmed.
  if (sameResponse(noToken, validToken)) {
    return notConfirmed('oracle does not distinguish authenticated from unauthenticated (no valid three-way baseline)');
  }

  for (const mutation of observation.mutations) {
    const matchesAuthenticated = sameResponse(mutation.signal, validToken);
    const differsFromNoToken = !sameResponse(mutation.signal, noToken);
    if (matchesAuthenticated && differsFromNoToken) {
      return {
        kind: 'verified',
        severity: DEFAULT_SEVERITY.jwt,
        proof: {
          summary: `Forged JWT (${mutation.kind}) elicited the authenticated response on ${oracleUrl}, materially different from the no-token response — the signature check was bypassed.`,
          signals: {
            mutation: mutation.kind,
            oracleUrl,
            forgedStatus: mutation.signal.status,
            validTokenStatus: validToken.status,
            noTokenStatus: noToken.status,
            forgedMatchesAuthenticated: true,
          },
        },
      };
    }
  }

  return notConfirmed('no forged token elicited the authenticated response (three-way none/valid/forged did not confirm)');
}
