import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { SsrfObservation } from '@corvid/tool-contracts';

import { verifySsrf } from '../src/index.ts';

function obs(sent: boolean): SsrfObservation {
  return { vulnClass: 'ssrf', param: { name: 'url', location: 'query' }, oobToken: 'tok-abc123', sent };
}

// ---- true positive: payload sent AND the listener saw a correlated callback ----

test('verified: payload was sent and a correlated OOB callback arrived for the token', () => {
  const result = verifySsrf(obs(true), true);
  assert.equal(result.kind, 'verified');
  if (result.kind === 'verified') {
    assert.match(result.proof.summary, /Blind SSRF confirmed/);
    assert.equal(result.proof.signals.outOfBandCallback, true);
    assert.equal(result.proof.signals.oobToken, 'tok-abc123');
  }
});

// ---- true negatives ----

test('not_confirmed (timeout): payload sent but no correlated callback within the D-4 bound', () => {
  // The load-bearing negative: a sent payload with no OOB callback is the timeout case, never verified.
  const result = verifySsrf(obs(true), false);
  assert.equal(result.kind, 'not_confirmed');
  if (result.kind === 'not_confirmed') assert.match(result.reason, /wait bound/);
});

test('not_confirmed: payload never went out (out-of-scope / deduplicated) — a callback cannot count', () => {
  // Even if a callback were (impossibly) reported, an unsent payload cannot be attributed to this test.
  const result = verifySsrf(obs(false), true);
  assert.equal(result.kind, 'not_confirmed');
  if (result.kind === 'not_confirmed') assert.match(result.reason, /not sent/);
});
