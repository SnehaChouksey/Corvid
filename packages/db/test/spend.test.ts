import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { DEFAULT_DAILY_SPEND_CEILINGS, evaluateDailySpend, utcDayStart } from '../src/index.ts';

const ceilings = { globalCeilingCredits: 5, userCeilingCredits: 1 };

test('allows a call while both global and per-user spend are under the ceiling', () => {
  const decision = evaluateDailySpend({ globalSpentCredits: 2, userSpentCredits: 0.5 }, ceilings);
  assert.equal(decision.allowed, true);
});

test('refuses and reports "user" scope when the per-user ceiling is reached', () => {
  const decision = evaluateDailySpend({ globalSpentCredits: 2, userSpentCredits: 1 }, ceilings);
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.equal(decision.trippedScope, 'user');
});

test('refuses and reports "global" scope when the global ceiling is reached', () => {
  const decision = evaluateDailySpend({ globalSpentCredits: 5, userSpentCredits: 0 }, ceilings);
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.equal(decision.trippedScope, 'global');
});

test('global is reported first when both are over (a global stop is global)', () => {
  const decision = evaluateDailySpend({ globalSpentCredits: 9, userSpentCredits: 9 }, ceilings);
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.equal(decision.trippedScope, 'global');
});

test('fails closed on a misconfigured (non-positive / non-finite) ceiling', () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const decision = evaluateDailySpend(
      { globalSpentCredits: 0, userSpentCredits: 0 },
      { globalCeilingCredits: bad, userCeilingCredits: 1 },
    );
    assert.equal(decision.allowed, false);
  }
});

test('default ceilings are conservative and positive (D-12)', () => {
  assert.ok(DEFAULT_DAILY_SPEND_CEILINGS.globalCeilingCredits > 0);
  assert.ok(DEFAULT_DAILY_SPEND_CEILINGS.userCeilingCredits > 0);
  assert.ok(
    DEFAULT_DAILY_SPEND_CEILINGS.userCeilingCredits <= DEFAULT_DAILY_SPEND_CEILINGS.globalCeilingCredits,
  );
});

test('utcDayStart returns UTC midnight of the given instant', () => {
  const start = utcDayStart(new Date('2026-08-12T15:30:00.000Z'));
  assert.equal(start.toISOString(), '2026-08-12T00:00:00.000Z');
});
