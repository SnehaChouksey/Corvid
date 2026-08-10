import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';

import { CrawlFrontier, createRedis, type RedisClient } from '../src/index.ts';

// Opt-in integration test: runs only when REDIS_URL points at a real Redis (mirrors the
// DATABASE_URL pattern in @corvid/db). Skips cleanly otherwise so CI without infra stays green.
const REDIS_URL = process.env.REDIS_URL;

if (REDIS_URL === undefined) {
  test('redis frontier integration (skipped — set REDIS_URL to run)', { skip: true }, () => {
    // intentionally empty
  });
} else {
  runIntegrationTests(REDIS_URL);
}

function runIntegrationTests(url: string): void {
  const redis: RedisClient = createRedis(url);
  const scanId = `test-${Date.now()}`;
  const frontier = new CrawlFrontier(redis, scanId, 60);

  after(async () => {
    await frontier.clear();
    redis.disconnect();
  });

  test('enqueue dedups: the same URL is only ever queued once', async () => {
    const first = await frontier.enqueue([
      { url: 'https://app.example.com/', depth: 0 },
      { url: 'https://app.example.com/a', depth: 1 },
    ]);
    assert.equal(first, 2);

    // Re-enqueueing an already-seen URL adds nothing — the property that terminates a cyclic crawl.
    const second = await frontier.enqueue([
      { url: 'https://app.example.com/a', depth: 1 },
      { url: 'https://app.example.com/b', depth: 1 },
    ]);
    assert.equal(second, 1);
    assert.equal(await frontier.size(), 3);
    assert.equal(await frontier.seenCount(), 3);
  });

  test('dequeue returns items FIFO then null when drained', async () => {
    const drained: string[] = [];
    for (;;) {
      const item = await frontier.dequeue();
      if (item === null) break;
      drained.push(item.url);
    }
    assert.deepEqual(drained, [
      'https://app.example.com/',
      'https://app.example.com/a',
      'https://app.example.com/b',
    ]);
    assert.equal(await frontier.dequeue(), null);
    // seen persists after drain — a URL visited earlier is not re-queued if re-discovered.
    assert.equal(await frontier.enqueue([{ url: 'https://app.example.com/a', depth: 1 }]), 0);
  });
}
