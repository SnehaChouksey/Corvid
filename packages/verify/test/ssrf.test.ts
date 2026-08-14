import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { OobCallback, SsrfObservation } from '@corvid/tool-contracts';

import { MAX_CALLBACK_LATENCY_MS, verifySsrf } from '../src/index.ts';

const SENT_AT = 1_000_000;

function obs(sent: boolean): SsrfObservation {
  return { vulnClass: 'ssrf', param: { name: 'url', location: 'query' }, oobToken: 'tok-abc123', sent, sentAt: SENT_AT };
}

const cb = (afterMs: number, sourceIp?: string): OobCallback => ({
  receivedAt: SENT_AT + afterMs,
  ...(sourceIp !== undefined ? { sourceIp } : {}),
});

// ---- true positive: payload sent AND the listener recorded a correlated callback in the window ----

test('verified: payload sent and a correlated OOB callback recorded within the window', () => {
  const result = verifySsrf(obs(true), cb(1_200, '203.0.113.9'));
  assert.equal(result.kind, 'verified');
  if (result.kind === 'verified') {
    assert.match(result.proof.summary, /Blind SSRF confirmed/);
    assert.match(result.proof.summary, /203\.0\.113\.9/); // provenance in the proof, not overclaimed
    assert.equal(result.proof.signals.outOfBandCallback, true);
    assert.equal(result.proof.signals.sourceIp, '203.0.113.9');
    assert.equal(result.proof.signals.latencyMs, 1_200);
  }
});

// ---- true negatives ----

test('not_confirmed (timeout): payload sent but no callback recorded', () => {
  const result = verifySsrf(obs(true), null);
  assert.equal(result.kind, 'not_confirmed');
  if (result.kind === 'not_confirmed') assert.match(result.reason, /no correlated OOB callback/);
});

test('not_confirmed: payload never went out (out-of-scope / deduplicated)', () => {
  const result = verifySsrf(obs(false), cb(500));
  assert.equal(result.kind, 'not_confirmed');
  if (result.kind === 'not_confirmed') assert.match(result.reason, /not sent/);
});

test('not_confirmed: a stale callback outside the correlation window does not confirm', () => {
  // A callback that surfaced long after the send (e.g. a sweep outage) is not attributable to it.
  const result = verifySsrf(obs(true), cb(MAX_CALLBACK_LATENCY_MS + 1));
  assert.equal(result.kind, 'not_confirmed');
  if (result.kind === 'not_confirmed') assert.match(result.reason, /correlation window/);
});
