import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { HttpSendOutput } from '@corvid/tool-contracts';

import { injectionFuzz, injectPayload, matchDbErrors, type SendFn } from '../src/index.ts';

const target = {
  scanId: '11111111-1111-4111-8111-111111111111',
  url: 'https://app.example.com/api/search?q=abc',
  method: 'GET' as const,
};
const qParam = { name: 'q', location: 'query' as const };

test('injectPayload places the value in the query param', () => {
  const r = injectPayload('https://app.example.com/api/search?q=abc', undefined, qParam, "'");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(new URL(r.url).searchParams.get('q'), "'");
});

test('injectPayload places the value in a JSON body param, preserving other fields', () => {
  const r = injectPayload('https://app.example.com/api/x', '{"q":"abc","page":1}', { name: 'q', location: 'body' }, "'");
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(JSON.parse(r.body ?? '{}'), { q: "'", page: 1 });
});

test('injectPayload refuses a path param and a non-JSON body instead of mislocating', () => {
  assert.equal(injectPayload('https://app.example.com/user/1', undefined, { name: 'id', location: 'path' }, "'").ok, false);
  assert.equal(injectPayload('https://app.example.com/x', 'a=1&b=2', { name: 'a', location: 'body' }, "'").ok, false);
});

test('injection tester surfaces not_sent(unsupported) for a path param, never a clean-looking observation', async () => {
  const anySend: SendFn = async () => ({ outcome: 'sent', response: { status: 200, headers: {}, body: 'x', timingMs: 1 } });
  const outcome = await injectionFuzz(anySend, { target, param: { name: 'id', location: 'path' } });
  assert.equal(outcome.kind, 'not_sent');
  if (outcome.kind === 'not_sent') assert.equal(outcome.reason, 'unsupported');
});

test('matchDbErrors detects known signatures by name and ignores a clean body', () => {
  assert.deepEqual(matchDbErrors('...PostgreSQL query failed: ERROR: unterminated quoted string...').includes('postgres'), true);
  assert.deepEqual(matchDbErrors('{"results":[]}'), []);
});

// A target that errors on an unescaped quote and sleeps for the injected pg_sleep duration.
const vulnerableTarget: SendFn = async (input): Promise<HttpSendOutput> => {
  const q = new URL(input.url).searchParams.get('q') ?? '';
  const sleep = /pg_sleep\((\d+)\)/.exec(q);
  if (sleep) {
    return { outcome: 'sent', response: { status: 200, headers: {}, body: 'ok', timingMs: Number(sleep[1]) * 1000 } };
  }
  if (q === "'") {
    return { outcome: 'sent', response: { status: 500, headers: {}, body: 'PostgreSQL: ERROR: unterminated quoted string at or near', timingMs: 8 } };
  }
  return { outcome: 'sent', response: { status: 200, headers: {}, body: '{"results":[]}', timingMs: 7 } };
};

test('injection tester emits per-attempt signals; error pattern only on the metacharacter, not the control', async () => {
  const outcome = await injectionFuzz(vulnerableTarget, { target, param: qParam });
  assert.equal(outcome.kind, 'observed');
  if (outcome.kind !== 'observed') return;

  const single = outcome.observation.attempts.find((a) => a.payloadFamily === 'single-quote');
  const control = outcome.observation.attempts.find((a) => a.payloadFamily === 'escaped-control');
  assert.deepEqual(single?.matchedErrorPatterns, ['postgres']); // error attributed to the metacharacter
  assert.deepEqual(control?.matchedErrorPatterns, []); // the FP guard: neutralized control has no error

  // Time-based dose-response: the 4s payload's latency is ~2x the 2s payload's (the verifier checks scaling).
  const t2 = outcome.observation.attempts.find((a) => a.payloadFamily === 'pg-sleep-2s');
  const t4 = outcome.observation.attempts.find((a) => a.payloadFamily === 'pg-sleep-4s');
  assert.equal(t2?.injected.timingMs, 2000);
  assert.equal(t4?.injected.timingMs, 4000);
});

test('a refusal surfaces as not_sent (no fabricated signal)', async () => {
  const refuse: SendFn = async () => ({ outcome: 'refused_out_of_scope' });
  const outcome = await injectionFuzz(refuse, { target, param: qParam });
  assert.equal(outcome.kind, 'not_sent');
});
