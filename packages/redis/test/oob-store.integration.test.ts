import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';

import { createRedis, OobCallbackStore, type RedisClient } from '../src/index.ts';

// Opt-in integration test: runs only when REDIS_URL points at a real Redis (mirrors the frontier
// test). Skips cleanly otherwise so CI without infra stays green.
const REDIS_URL = process.env.REDIS_URL;

if (REDIS_URL === undefined) {
  test('oob-store integration (skipped — set REDIS_URL to run)', { skip: true }, () => {
    // intentionally empty
  });
} else {
  runIntegrationTests(REDIS_URL);
}

function runIntegrationTests(url: string): void {
  const redis: RedisClient = createRedis(url);
  const scanId = '22222222-2222-4222-8222-222222222222';
  const store = new OobCallbackStore(redis, 60);
  let token = '';

  after(() => {
    redis.disconnect();
  });

  test('register mints a token bound to the scan; not yet called back', async () => {
    token = await store.register(scanId);
    assert.match(token, /^[0-9a-f]{32}$/);
    assert.equal(await store.getCallback(token), null);
  });

  test('markCalledBack records a correlated callback with provenance exactly once (single-use)', async () => {
    const first = await store.markCalledBack(token, { receivedAt: 1_000, sourceIp: '203.0.113.5' });
    assert.deepEqual(first, { recorded: true, scanId });
    const cb = await store.getCallback(token);
    assert.equal(cb?.receivedAt, 1_000);
    assert.equal(cb?.sourceIp, '203.0.113.5');

    // A second callback for the same token is idempotent — recorded:false, provenance unchanged.
    const second = await store.markCalledBack(token, { receivedAt: 9_999, sourceIp: '198.51.100.9' });
    assert.equal(second.recorded, false);
    assert.equal(second.scanId, scanId);
    assert.equal((await store.getCallback(token))?.receivedAt, 1_000); // first callback wins
  });

  test('an unregistered token records nothing (the correlation guard)', async () => {
    const unknown = 'ffffffffffffffffffffffffffffffff';
    assert.deepEqual(await store.markCalledBack(unknown, { receivedAt: 1 }), { recorded: false });
    assert.equal(await store.getCallback(unknown), null);
  });
}
