import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { JwtObservation, ResponseSignal } from '@corvid/tool-contracts';

import { verifyJwt } from '../src/index.ts';

function sig(status: number, bodyHash: string): ResponseSignal {
  return { status, bodyLength: 128, timingMs: 5, bodyHash };
}

const AUTHED = 'hash-authenticated';
const ANON = 'hash-anonymous';

function observation(over: Partial<JwtObservation> = {}): JwtObservation {
  return {
    vulnClass: 'jwt',
    oracleUrl: 'https://app.example.com/api/me',
    noToken: sig(401, ANON),
    validToken: sig(200, AUTHED),
    mutations: [{ kind: 'alg_none', signal: sig(200, AUTHED) }],
    ...over,
  };
}

// ---- true positive ----

test('verified: a forged token elicits the authenticated response, distinct from no-token', () => {
  const result = verifyJwt(observation());
  assert.equal(result.kind, 'verified');
  if (result.kind === 'verified') {
    assert.match(result.proof.summary, /Forged JWT \(alg_none\)/);
    assert.equal(result.proof.signals.forgedMatchesAuthenticated, true);
    assert.ok(result.severity.includes('CVSS:3.1/'));
  }
});

test('verified attributes the specific mutation that worked (e.g. HS/RS confusion)', () => {
  const result = verifyJwt(
    observation({
      mutations: [
        { kind: 'alg_none', signal: sig(401, ANON) }, // rejected
        { kind: 'hs_rs_confusion', signal: sig(200, AUTHED) }, // accepted
      ],
    }),
  );
  assert.equal(result.kind, 'verified');
  if (result.kind === 'verified') assert.equal(result.proof.signals.mutation, 'hs_rs_confusion');
});

// ---- true negatives (the false-positive guards) ----

test('not_confirmed: the oracle does not distinguish auth from no-auth (no three-way baseline)', () => {
  // A public endpoint: valid token and no token look identical → nothing can be proven.
  const result = verifyJwt(observation({ noToken: sig(200, AUTHED), validToken: sig(200, AUTHED) }));
  assert.equal(result.kind, 'not_confirmed');
});

test('not_confirmed: the forged token is rejected (matches the no-token response)', () => {
  const result = verifyJwt(observation({ mutations: [{ kind: 'alg_none', signal: sig(401, ANON) }] }));
  assert.equal(result.kind, 'not_confirmed');
});

test('not_confirmed: a bare 200 that is NOT the authenticated response never confirms', () => {
  // The forged token returns 200, but a *different* body than the valid-token response — e.g. a
  // generic page, not the authenticated content. A status-only check would wrongly confirm this.
  const result = verifyJwt(observation({ mutations: [{ kind: 'alg_none', signal: sig(200, 'hash-some-other-200') }] }));
  assert.equal(result.kind, 'not_confirmed');
});

test('not_confirmed: no mutations attempted (nothing to confirm)', () => {
  const result = verifyJwt(observation({ mutations: [] }));
  assert.equal(result.kind, 'not_confirmed');
});
