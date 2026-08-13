import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { isCorvidError } from '@corvid/errors';
import type { ScopeRules } from '@corvid/scope';
import type { HttpResponse, HttpSendInput } from '@corvid/tool-contracts';

import {
  createHttpSend,
  isThrottleSignal,
  nextDelayMs,
  type FetchRequest,
  type HttpSendPorts,
  type ResolvedTarget,
} from '../src/index.ts';

const SCAN = '11111111-1111-4111-8111-111111111111';
const SCOPE: ScopeRules = { hosts: ['app.example.com'] };
const inScope: HttpSendInput = { scanId: SCAN, method: 'GET', url: 'https://app.example.com/api/orders/1' };

interface Recorded {
  audits: string[];
  fetched: FetchRequest[];
  slept: number[];
}

function makeSender(opts: {
  target?: ResolvedTarget | undefined;
  seen?: Set<string>;
  response?: HttpResponse;
}): { send: (i: HttpSendInput) => Promise<unknown>; rec: Recorded } {
  const rec: Recorded = { audits: [], fetched: [], slept: [] };
  const seen = opts.seen ?? new Set<string>();
  const ports: HttpSendPorts = {
    resolveTarget: async () => ('target' in opts ? opts.target : { scope: SCOPE, authorized: true }),
    markNewRequest: async (_scanId, key) => {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
    fetch: async (req) => {
      rec.fetched.push(req);
      return opts.response ?? { status: 200, headers: {}, body: '{}', timingMs: 5 };
    },
    audit: async (e) => {
      rec.audits.push(e.action);
    },
    sleep: async (ms) => {
      rec.slept.push(ms);
    },
    now: () => 1_000_000,
  };
  return { send: createHttpSend(ports).send, rec };
}

test('an unauthorized target fails loud (AuthorizationError) and never fetches', async () => {
  const { send, rec } = makeSender({ target: { scope: SCOPE, authorized: false } });
  await assert.rejects(send(inScope), (e: unknown) => isCorvidError(e) && e.kind === 'authorization');
  assert.equal(rec.fetched.length, 0);
  assert.ok(rec.audits.includes('http.send.refused_unauthorized'));
});

test('a missing target also fails loud and never fetches', async () => {
  const { send, rec } = makeSender({ target: undefined });
  await assert.rejects(send(inScope), (e: unknown) => isCorvidError(e) && e.kind === 'authorization');
  assert.equal(rec.fetched.length, 0);
});

test('an out-of-scope URL is refused + audited, and never reaches the network', async () => {
  const { send, rec } = makeSender({});
  const result = await send({ scanId: SCAN, method: 'GET', url: 'https://evil.example.com/api/x' });
  assert.deepEqual(result, { outcome: 'refused_out_of_scope' });
  assert.equal(rec.fetched.length, 0);
  assert.ok(rec.audits.includes('http.send.refused_out_of_scope'));
});

test('an in-scope request is sent and returns the response observation', async () => {
  const { send, rec } = makeSender({ response: { status: 200, headers: { x: 'y' }, body: 'ok', timingMs: 12 } });
  const result = await send(inScope);
  assert.deepEqual(result, {
    outcome: 'sent',
    response: { status: 200, headers: { x: 'y' }, body: 'ok', timingMs: 12 },
  });
  assert.equal(rec.fetched.length, 1);
  assert.ok(rec.audits.includes('http.send.request'));
  assert.ok(rec.audits.includes('http.send.response'));
});

test('a duplicate request in the same scan is not re-sent (replay-safe)', async () => {
  const seen = new Set<string>();
  const { send, rec } = makeSender({ seen });
  await send(inScope);
  const second = await send(inScope);
  assert.deepEqual(second, { outcome: 'deduplicated' });
  assert.equal(rec.fetched.length, 1); // only the first actually went out
});

test('same URL with different auth headers is NOT deduped (JWT/IDOR need this)', async () => {
  const { send, rec } = makeSender({});
  await send({ ...inScope, headers: { authorization: 'Bearer token-A' } });
  const second = await send({ ...inScope, headers: { authorization: 'Bearer token-B' } });
  const noAuth = await send({ ...inScope }); // no token at all
  assert.equal((second as { outcome: string }).outcome, 'sent'); // different auth → a distinct request
  assert.equal((noAuth as { outcome: string }).outcome, 'sent');
  assert.equal(rec.fetched.length, 3);
});

test('a throttle response grows the next min-delay (adaptive backoff, D-2)', async () => {
  const { send, rec } = makeSender({ response: { status: 429, headers: {}, body: '', timingMs: 1 } });
  // First send: no prior state, wait 0. The 429 grows the stored delay.
  await send({ scanId: SCAN, method: 'GET', url: 'https://app.example.com/a' });
  // Second send: now() is fixed, so the full grown delay is waited.
  await send({ scanId: SCAN, method: 'GET', url: 'https://app.example.com/b' });
  const lastSleep = rec.slept.at(-1) ?? 0;
  assert.ok(lastSleep >= 1000, `expected backoff >= 1000ms, got ${lastSleep}`);
});

test('rate posture pure helpers: throttle detection + geometric backoff to a ceiling', () => {
  assert.equal(isThrottleSignal(429), true);
  assert.equal(isThrottleSignal(403), true);
  assert.equal(isThrottleSignal(200), false);
  const cfg = { baseDelayMs: 500, maxDelayMs: 15_000, backoffMultiplier: 2 };
  assert.equal(nextDelayMs(500, 429, cfg), 1000);
  assert.equal(nextDelayMs(200, 200, cfg), 500); // settles back to base on a clean response
  assert.equal(nextDelayMs(10_000, 429, cfg), 15_000); // capped at the ceiling
});
