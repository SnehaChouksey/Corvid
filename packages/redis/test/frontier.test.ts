import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { InfraError, isCorvidError } from '@corvid/errors';
import type { Redis } from 'ioredis';

import { CrawlFrontier } from '../src/frontier.ts';

// Always-on unit tests for the fail-closed branch (M5): a lost/failed Redis pipeline must surface an
// InfraError, never a silent "0 enqueued" that would let a crawl complete against an empty surface.
// The happy path (real dedup/FIFO) is covered opt-in against a real Redis in the integration test.

type PipelineResult = [Error | null, unknown];

/** Chainable pipeline stub whose exec() yields a preprogrammed result. */
class FakePipeline {
  readonly #result: PipelineResult[] | null;
  constructor(result: PipelineResult[] | null) {
    this.#result = result;
  }
  sadd(): this {
    return this;
  }
  rpush(): this {
    return this;
  }
  expire(): this {
    return this;
  }
  async exec(): Promise<PipelineResult[] | null> {
    return this.#result;
  }
}

/** Minimal ioredis stand-in: each pipeline() call returns the next preprogrammed result. Indexed
 * (not shift + `??`) so a deliberately-programmed `null` result is preserved, not coerced to `[]`. */
function fakeRedis(pipelineResults: (PipelineResult[] | null)[]): Redis {
  let i = 0;
  return {
    pipeline: () => {
      const result = i < pipelineResults.length ? pipelineResults[i] : [];
      i++;
      return new FakePipeline(result === undefined ? [] : result);
    },
  } as unknown as Redis;
}

test('enqueue fails closed when the dedup pipeline is lost (null result)', async () => {
  const frontier = new CrawlFrontier(fakeRedis([null]), 'scan-1');
  await assert.rejects(
    frontier.enqueue([{ url: 'https://app.example.com/', depth: 0 }]),
    (err: unknown) => isCorvidError(err) && err instanceof InfraError && err.retryable,
  );
});

test('enqueue fails closed when a dedup command errors', async () => {
  const frontier = new CrawlFrontier(fakeRedis([[[new Error('ECONNRESET'), null]]]), 'scan-2');
  await assert.rejects(
    frontier.enqueue([{ url: 'https://app.example.com/', depth: 0 }]),
    InfraError,
  );
});

test('enqueue fails closed when the push pipeline is lost after dedup succeeds', async () => {
  // Dedup pipeline reports the URL as new (SADD → 1), but the RPUSH pipeline is lost: the URL is
  // now marked seen yet never queued. Fail closed rather than silently drop it from the crawl.
  const frontier = new CrawlFrontier(fakeRedis([[[null, 1]], null]), 'scan-3');
  await assert.rejects(
    frontier.enqueue([{ url: 'https://app.example.com/', depth: 0 }]),
    InfraError,
  );
});
