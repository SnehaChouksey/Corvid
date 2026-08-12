import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { InfraError, isCorvidError } from '@corvid/errors';
import type { Redis } from 'ioredis';

import { HypothesisDedup } from '../src/hypothesis-dedup.ts';

// Always-on unit tests for the fail-closed branch (M5): a lost/errored Redis pipeline must surface
// an InfraError, never a silent empty result that a caller could read as "nothing new" and drop
// hypotheses. The happy path (real dedup) is covered opt-in against a real Redis in the integration
// test below.

type PipelineResult = [Error | null, unknown];

class FakePipeline {
  readonly #result: PipelineResult[] | null;
  constructor(result: PipelineResult[] | null) {
    this.#result = result;
  }
  sadd(): this {
    return this;
  }
  expire(): this {
    return this;
  }
  async exec(): Promise<PipelineResult[] | null> {
    return this.#result;
  }
}

function fakeRedis(result: PipelineResult[] | null): Redis {
  return { pipeline: () => new FakePipeline(result) } as unknown as Redis;
}

test('filterUnseen fails closed when the pipeline is lost (null result)', async () => {
  const dedup = new HypothesisDedup(fakeRedis(null), 'scan-1');
  await assert.rejects(
    dedup.filterUnseen(['fp-a']),
    (err: unknown) => isCorvidError(err) && err instanceof InfraError && err.retryable,
  );
});

test('filterUnseen fails closed when a command errors', async () => {
  const dedup = new HypothesisDedup(fakeRedis([[new Error('ECONNRESET'), null]]), 'scan-2');
  await assert.rejects(dedup.filterUnseen(['fp-a']), InfraError);
});

test('filterUnseen on an empty list is a no-op (returns [])', async () => {
  // Must not touch Redis at all — a throwing pipeline proves it short-circuits first.
  const throwing = {
    pipeline: () => {
      throw new Error('should not be called');
    },
  } as unknown as Redis;
  const dedup = new HypothesisDedup(throwing, 'scan-3');
  assert.deepEqual(await dedup.filterUnseen([]), []);
});

// ---- Integration (opt-in): real Redis ----
const REDIS_URL = process.env.REDIS_URL;
if (REDIS_URL === undefined) {
  test('hypothesis-dedup integration (skipped — set REDIS_URL to run)', { skip: true }, () => {});
} else {
  const { createRedis } = await import('../src/client.ts');

  test('filterUnseen returns only the fresh fingerprints and dedups repeats', async () => {
    const redis = createRedis(REDIS_URL);
    const scanId = `dedup-${process.pid}-${Math.round(process.hrtime()[1])}`;
    const dedup = new HypothesisDedup(redis, scanId, 60);
    try {
      const first = await dedup.filterUnseen(['a', 'b', 'c']);
      assert.deepEqual([...first].sort(), ['a', 'b', 'c']);

      const second = await dedup.filterUnseen(['b', 'c', 'd']); // only 'd' is new
      assert.deepEqual(second, ['d']);

      assert.equal(await dedup.has('a'), true);
      assert.equal(await dedup.has('z'), false);
      assert.equal(await dedup.seenCount(), 4);
    } finally {
      await dedup.clear();
      redis.disconnect();
    }
  });
}
