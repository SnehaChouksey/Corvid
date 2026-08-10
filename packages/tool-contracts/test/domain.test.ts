import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { assertNever } from '../src/index.ts';
import type { VerificationOutcome } from '../src/index.ts';

test('assertNever throws on a value that escaped the type system', () => {
  // Models a bad value arriving from an untrusted boundary despite the static type.
  assert.throws(() => assertNever('unexpected' as never), /Unhandled union member/);
});

test('verification error is distinct from not_confirmed (CODING_STANDARDS §4)', () => {
  const outcomes: readonly VerificationOutcome[] = [
    { kind: 'verified' },
    { kind: 'not_confirmed' },
    { kind: 'error', reason: 'timeout' },
  ];

  // A tooling error must route differently from a clean negative — conflating them is how a
  // real vulnerability gets missed, so the switch proves each branch is reachable and separate.
  const route = (o: VerificationOutcome): string => {
    switch (o.kind) {
      case 'verified':
        return 'report';
      case 'not_confirmed':
        return 'drop';
      case 'error':
        return `retry:${o.reason}`;
      default:
        return assertNever(o);
    }
  };

  assert.deepEqual(outcomes.map(route), ['report', 'drop', 'retry:timeout']);
});
