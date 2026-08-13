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
}

export type IdorOutcome = { readonly kind: 'observed'; readonly observation: IdorObservation } | NotSent;

export async function idorCompare(send: SendFn, input: IdorCompareInput): Promise<IdorOutcome> {
  const { target } = input;
  const base = {
    scanId: target.scanId,
    method: target.method,
    url: target.url,
    ...(input.baseBody !== undefined ? { body: input.baseBody } : {}),
  };

  const low = signalFrom(await send({ ...base, headers: input.lowPrivilege.headers }));
  if (!low.ok) return { kind: 'not_sent', reason: low.notSent };

  const high = signalFrom(await send({ ...base, headers: input.highPrivilege.headers }));
  if (!high.ok) return { kind: 'not_sent', reason: high.notSent };

  return {
    kind: 'observed',
    observation: {
      vulnClass: 'idor',
      endpoint: target.url,
      method: target.method,
      lowPrivilege: low.signal,
      highPrivilege: high.signal,
    },
  };
}
