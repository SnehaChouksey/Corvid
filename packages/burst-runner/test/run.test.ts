import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { BurstInput, HttpResponse } from '@corvid/tool-contracts';

import { runBurst } from '../src/run.ts';

// A fake network that returns a fixed 200 for every request, so the testers produce observations
// without a real target. The point here is dispatch + composition, not signal detection (the gate,
// tested in @corvid/verify, decides verified/not from these observations).
const ok200 = async (): Promise<HttpResponse> => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: '{"ok":true}',
  timingMs: 5,
});

const baseInput = (hypotheses: BurstInput['hypotheses'], extra: Partial<BurstInput> = {}): BurstInput => ({
  scanId: '11111111-1111-1111-1111-111111111111',
  scope: { hosts: ['app.example.com'] },
  credentials: null,
  hypotheses,
  ...extra,
});

// Never actually sleep for the rate posture, and use a real-ish clock.
const fast = { fetchImpl: ok200, sleep: async () => {}, now: () => 1_000 };

test('dispatches a JWT hypothesis and emits a jwt observation when a sample JWT is supplied', async () => {
  const input = baseInput(
    [
      {
        hypothesisId: '22222222-2222-2222-2222-222222222222',
        vulnClass: 'jwt',
        url: 'https://app.example.com/api/me',
        method: 'GET',
        payloadFamily: 'alg-none',
      },
    ],
    { credentials: { jwtSample: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.aaaa' } },
  );

  const out = await runBurst(input, fast);
  assert.equal(out.observations.length, 1);
  assert.equal(out.observations[0]?.observation?.vulnClass, 'jwt');
  assert.equal(out.errors.length, 0);
});

test('a JWT hypothesis with no sample JWT yields a null observation (nothing to send)', async () => {
  const input = baseInput([
    {
      hypothesisId: '33333333-3333-3333-3333-333333333333',
      vulnClass: 'jwt',
      url: 'https://app.example.com/api/me',
      method: 'GET',
      payloadFamily: 'alg-none',
    },
  ]);
  const out = await runBurst(input, fast);
  assert.equal(out.observations[0]?.observation, null);
});

test('dispatches an injection hypothesis on a query param and emits an injection observation', async () => {
  const input = baseInput([
    {
      hypothesisId: '44444444-4444-4444-4444-444444444444',
      vulnClass: 'injection',
      url: 'https://app.example.com/search',
      method: 'GET',
      param: { name: 'q', location: 'query' },
      payloadFamily: 'sqli-error',
    },
  ]);
  const out = await runBurst(input, fast);
  assert.equal(out.observations[0]?.observation?.vulnClass, 'injection');
});

test('an out-of-scope target yields a null observation (http.send refuses)', async () => {
  const input = baseInput([
    {
      hypothesisId: '55555555-5555-5555-5555-555555555555',
      vulnClass: 'injection',
      url: 'https://evil.example.net/search',
      method: 'GET',
      param: { name: 'q', location: 'query' },
      payloadFamily: 'sqli-error',
    },
  ]);
  const out = await runBurst(input, fast);
  assert.equal(out.observations[0]?.observation, null);
});

test('a tester tooling error is recorded in errors (never a fabricated clean negative) with a null observation', async () => {
  const input = baseInput([
    {
      hypothesisId: '66666666-6666-6666-6666-666666666666',
      vulnClass: 'ssrf',
      url: 'https://app.example.com/fetch',
      method: 'POST',
      param: { name: 'url', location: 'body' },
      payloadFamily: 'oob',
    },
  ]);
  // SSRF registers an OOB token first; make that throw to simulate a tooling failure.
  const out = await runBurst(input, {
    ...fast,
    oobRegister: async () => {
      throw new Error('oob_down');
    },
  });
  assert.equal(out.observations[0]?.observation, null);
  assert.equal(out.errors.length, 1);
  assert.equal(out.errors[0]?.hypothesisId, '66666666-6666-6666-6666-666666666666');
});
