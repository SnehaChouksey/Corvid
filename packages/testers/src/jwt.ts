import type { JwtMutationKind, JwtObservation, ResponseSignal } from '@corvid/tool-contracts';

import { mutateAlgNone, mutateHsRsConfusion, mutateKeyReuse } from './jwt-mutate.ts';
import { signalFrom } from './signal.ts';
import type { NotSent, SendFn, TesterTarget } from './types.ts';

// jwt.mutate_test (Unit 4, D-13). Collects the three-way auth-state signal on the oracle endpoint —
// no token, the analyst-supplied valid token, and each forged/mutated token — and emits it as an
// observation. It does NOT decide whether the forgery worked; the verifier's three-way comparison
// (none / valid / forged on a stable discriminator) does (§8, ADR-01). Every request goes through
// http.send, so scope/rate/dedup/audit are enforced.

export interface JwtTesterInput {
  readonly target: TesterTarget;
  /** Analyst-supplied valid JWT (D-1) — the baseline authenticated token. */
  readonly sampleJwt: string;
  /** RS public key (PEM) — when known, enables the HS/RS confusion mutation. */
  readonly publicKeyPem?: string;
  /** A candidate signing secret — when known, enables the key-reuse mutation. */
  readonly keyReuseSecret?: string;
}

export type JwtTesterOutcome = { readonly kind: 'observed'; readonly observation: JwtObservation } | NotSent;

function bearer(jwt: string): { authorization: string } {
  return { authorization: `Bearer ${jwt}` };
}

export async function jwtMutateTest(send: SendFn, input: JwtTesterInput): Promise<JwtTesterOutcome> {
  const { target } = input;
  const base = { scanId: target.scanId, method: target.method, url: target.url };

  const noToken = signalFrom(await send({ ...base }));
  if (!noToken.ok) return { kind: 'not_sent', reason: noToken.notSent };

  const validToken = signalFrom(await send({ ...base, headers: bearer(input.sampleJwt) }));
  if (!validToken.ok) return { kind: 'not_sent', reason: validToken.notSent };

  // Build the mutations we can actually produce from the material available.
  const forged: { kind: JwtMutationKind; token: string }[] = [
    { kind: 'alg_none', token: mutateAlgNone(input.sampleJwt) },
  ];
  if (input.publicKeyPem !== undefined) {
    forged.push({ kind: 'hs_rs_confusion', token: mutateHsRsConfusion(input.sampleJwt, input.publicKeyPem) });
  }
  if (input.keyReuseSecret !== undefined) {
    forged.push({ kind: 'key_reuse', token: mutateKeyReuse(input.sampleJwt, input.keyReuseSecret) });
  }

  const mutations: { kind: JwtMutationKind; signal: ResponseSignal }[] = [];
  for (const mutant of forged) {
    const result = signalFrom(await send({ ...base, headers: bearer(mutant.token) }));
    if (!result.ok) return { kind: 'not_sent', reason: result.notSent };
    mutations.push({ kind: mutant.kind, signal: result.signal });
  }

  return {
    kind: 'observed',
    observation: {
      vulnClass: 'jwt',
      oracleUrl: target.url,
      noToken: noToken.signal,
      validToken: validToken.signal,
      mutations,
    },
  };
}
