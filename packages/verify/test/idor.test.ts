import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { IdorObservation, ResponseSignal } from '@corvid/tool-contracts';

import { verifyIdor } from '../src/index.ts';

function sig(status: number, bodyHash: string): ResponseSignal {
  return { status, bodyLength: 150, timingMs: 6, bodyHash };
}

const VICTIM = 'hash-victim-basket';
const OWN = 'hash-own-basket';

function observation(over: Partial<IdorObservation> = {}): IdorObservation {
  return {
    vulnClass: 'idor',
    endpoint: 'https://app.example.com/rest/basket/7',
    method: 'GET',
    lowPrivilege: sig(200, VICTIM), // A reading B's basket → gets B's data
    highPrivilege: sig(200, VICTIM), // B reading B's basket → same
    controlSelf: sig(200, OWN), // A reading A's own basket → succeeds, different data
    controlAbsent: sig(404, 'hash-404'), // A reading a non-existent id → denied
    controlUnauth: sig(401, 'hash-unauth'), // no session → refused (endpoint is access-controlled)
    ...over,
  };
}

// ---- true positive ----

test('verified: A reads the victim’s object (== owner, ≠ own) with controls holding', () => {
  const result = verifyIdor(observation());
  assert.equal(result.kind, 'verified');
  if (result.kind === 'verified') {
    assert.match(result.proof.summary, /IDOR confirmed/);
    assert.equal(result.proof.signals.matchesOwner, true);
  }
});

// ---- true negatives (the false-positive guards) ----

test('not_confirmed: missing controls', () => {
  assert.equal(verifyIdor(observation({ controlSelf: undefined, controlAbsent: undefined })).kind, 'not_confirmed');
  assert.equal(verifyIdor(observation({ controlUnauth: undefined })).kind, 'not_confirmed'); // no access-control proof
});

test('not_confirmed: PUBLIC endpoint — an unauthenticated request returns the same object (not IDOR)', () => {
  // The no-auth control gets the victim's data too, so the object isn't access-controlled at all —
  // reporting IDOR here would be a false positive. This is the guard the unauth control exists for.
  const result = verifyIdor(observation({ controlUnauth: sig(200, VICTIM) }));
  assert.equal(result.kind, 'not_confirmed');
});

test('not_confirmed: endpoint returns the CALLER’S OWN object regardless of id (A==own, ≠ owner)', () => {
  // Broken? No — A just got its own basket back, not B's. lowPrivilege equals A's own control.
  const result = verifyIdor(observation({ lowPrivilege: sig(200, OWN), highPrivilege: sig(200, VICTIM) }));
  assert.equal(result.kind, 'not_confirmed');
});

test('not_confirmed: universal-content endpoint — a non-existent id returns the SAME data as the victim', () => {
  // The endpoint hands back the victim's payload for any id, so "A read B's basket" proves nothing.
  const result = verifyIdor(observation({ controlAbsent: sig(200, VICTIM) }));
  assert.equal(result.kind, 'not_confirmed');
});

test('not_confirmed: A’s own session does not even work (self control fails)', () => {
  const result = verifyIdor(observation({ controlSelf: sig(401, 'hash-unauth') }));
  assert.equal(result.kind, 'not_confirmed');
});

test('not_confirmed: A was denied the victim’s object (low-priv not a success)', () => {
  const result = verifyIdor(observation({ lowPrivilege: sig(403, 'hash-forbidden') }));
  assert.equal(result.kind, 'not_confirmed');
});
