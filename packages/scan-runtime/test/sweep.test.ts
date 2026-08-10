import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { OOB_TIMEOUT_MS, findTimedOutThreads } from '../src/index.ts';

test('findTimedOutThreads returns only threads that reached the OOB bound (D-4)', () => {
  const now = 1_000_000;
  const threads = [
    { threadId: 'fresh', interruptedAt: now - 1_000 },
    { threadId: 'exactly', interruptedAt: now - OOB_TIMEOUT_MS },
    { threadId: 'old', interruptedAt: now - OOB_TIMEOUT_MS - 5_000 },
  ];
  // A tooling/wait timeout is a deliberate "not confirmed" resolution, never a hang.
  assert.deepEqual(findTimedOutThreads(threads, now), ['exactly', 'old']);
  assert.deepEqual(findTimedOutThreads([], now), []);
});
