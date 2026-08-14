import type { IdorObservation, ResponseSignal } from '@corvid/tool-contracts';

import { DEFAULT_SEVERITY, notConfirmed, type VerifyResult } from './types.ts';

// IDOR verification (D-15). Confirmed only when the low-privilege session obtains the VICTIM's data
// AND the controls rule out the two classic false positives. The load-bearing checks:
//   - A's response to the victim's object is byte-identical to the owner's response (A got B's data),
//   - and DIFFERENT from A's response to a resource A legitimately owns (so it isn't the endpoint
//     simply returning the caller's own object regardless of id),
//   - A's self control succeeds (A's session works — not a universal 401),
//   - A's absent control does not return the victim's data (a non-existent id yields an error or an
//     empty/null body — so the endpoint discriminates, ruling out one that returns the same data for
//     any id). Deterministic, no LLM.

function sameResponse(a: ResponseSignal, b: ResponseSignal): boolean {
  return a.status === b.status && a.bodyHash === b.bodyHash;
}

function isSuccess(signal: ResponseSignal): boolean {
  return signal.status >= 200 && signal.status < 400;
}

export function verifyIdor(observation: IdorObservation): VerifyResult {
  const { lowPrivilege, highPrivilege, controlSelf, controlAbsent, endpoint } = observation;

  if (controlSelf === undefined || controlAbsent === undefined) {
    return notConfirmed('missing D-15 controls (A-on-own, A-on-absent) — cannot rule out broken-auth / universal access');
  }

  const gotVictimData =
    isSuccess(lowPrivilege) && sameResponse(lowPrivilege, highPrivilege) && !sameResponse(lowPrivilege, controlSelf);
  const selfControlHolds = isSuccess(controlSelf); // A's session works on a resource it owns
  // A non-existent id must NOT return the victim's data — whether by an error status or by returning
  // empty/null content. This rules out a universal endpoint that returns the same data for any id.
  // (Content check, not status: some apps answer a bogus id with 200 + an empty/null body.)
  const absentControlHolds = !sameResponse(controlAbsent, lowPrivilege);

  if (gotVictimData && selfControlHolds && absentControlHolds) {
    return {
      kind: 'verified',
      severity: DEFAULT_SEVERITY.idor,
      proof: {
        summary: `IDOR confirmed on ${endpoint}: the low-privilege session read the victim's object (byte-identical to the owner's response, and distinct from its own) while a non-existent id did not return that data.`,
        signals: {
          endpoint,
          lowStatus: lowPrivilege.status,
          matchesOwner: true,
          distinctFromOwnResource: true,
          absentDistinct: true,
        },
      },
    };
  }

  return notConfirmed(
    "cross-session ownership proof did not hold (need: A reads B's data, distinct from A's own; A's self control succeeds; A's absent control fails)",
  );
}
