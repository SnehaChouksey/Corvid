import type { IdorObservation } from '@corvid/tool-contracts';

import { signalFrom } from './signal.ts';
import type { NotSent, SendFn, TesterTarget } from './types.ts';

// idor.compare (Unit 4, D-15). Issues the SAME request (targeting one resource) under two
// analyst-supplied sessions at different privilege, and emits both response signals. It does NOT
// decide access: the verifier's labeled cross-session ownership proof (with controls) does that in
// Unit 5. The two sessions carry different auth headers, so the header-aware http.send dedup treats
// them as distinct requests (they are).

/** An analyst-supplied session (D-1): the auth headers that identify a logged-in user. */
export interface IdorSession {
  readonly headers: Record<string, string>;
}

export interface IdorCompareInput {
  readonly target: TesterTarget;
  /** The lower-privilege session — the one that should NOT be able to reach the resource. */
  readonly lowPrivilege: IdorSession;
  /** The higher-privilege / owning session — the expected-authorized baseline. */
  readonly highPrivilege: IdorSession;
  readonly baseBody?: string;
  /** D-15 self control: a resource the low-priv session legitimately owns (should succeed). */
  readonly ownResourceUrl?: string;
  /** D-15 absent control: a non-existent id under the low-priv session (should fail). */
  readonly absentResourceUrl?: string;
  /** D-15 access-control control: re-issue the target request with NO auth headers. If it still
   * returns the object, the endpoint is public (not IDOR) and the verifier must refuse. */
  readonly unauthControl?: boolean;
}

export type IdorOutcome = { readonly kind: 'observed'; readonly observation: IdorObservation } | NotSent;

export async function idorCompare(send: SendFn, input: IdorCompareInput): Promise<IdorOutcome> {
  const { target } = input;
  const base = {
    scanId: target.scanId,
    method: target.method,
    ...(input.baseBody !== undefined ? { body: input.baseBody } : {}),
  };

  const low = signalFrom(await send({ ...base, url: target.url, headers: input.lowPrivilege.headers }));
  if (!low.ok) return { kind: 'not_sent', reason: low.notSent };

  const high = signalFrom(await send({ ...base, url: target.url, headers: input.highPrivilege.headers }));
  if (!high.ok) return { kind: 'not_sent', reason: high.notSent };

  // D-15 controls, issued under the LOW-priv session, when the caller supplies the control URLs.
  let controlSelf: IdorObservation['controlSelf'];
  if (input.ownResourceUrl !== undefined) {
    const c = signalFrom(await send({ ...base, url: input.ownResourceUrl, headers: input.lowPrivilege.headers }));
    if (!c.ok) return { kind: 'not_sent', reason: c.notSent };
    controlSelf = c.signal;
  }
  let controlAbsent: IdorObservation['controlAbsent'];
  if (input.absentResourceUrl !== undefined) {
    const c = signalFrom(await send({ ...base, url: input.absentResourceUrl, headers: input.lowPrivilege.headers }));
    if (!c.ok) return { kind: 'not_sent', reason: c.notSent };
    controlAbsent = c.signal;
  }

  // Access-control control: the target request with NO auth headers. A public endpoint returns the
  // object here too, which the verifier uses to rule out a false "IDOR" on unprotected data.
  let controlUnauth: IdorObservation['controlUnauth'];
  if (input.unauthControl === true) {
    const c = signalFrom(await send({ ...base, url: target.url, headers: {} }));
    if (!c.ok) return { kind: 'not_sent', reason: c.notSent };
    controlUnauth = c.signal;
  }

  return {
    kind: 'observed',
    observation: {
      vulnClass: 'idor',
      endpoint: target.url,
      method: target.method,
      lowPrivilege: low.signal,
      highPrivilege: high.signal,
      ...(controlSelf !== undefined ? { controlSelf } : {}),
      ...(controlAbsent !== undefined ? { controlAbsent } : {}),
      ...(controlUnauth !== undefined ? { controlUnauth } : {}),
    },
  };
}
