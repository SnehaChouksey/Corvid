import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { testerInputSchema, testerObservationSchema } from '../src/index.ts';

const SCAN_ID = '11111111-1111-4111-8111-111111111111';
const HYP_ID = '22222222-2222-4222-8222-222222222222';

const sig = (status: number) => ({ status, bodyLength: 128, timingMs: 30, bodyHash: 'a'.repeat(64) });

test('tester input is only scanId + hypothesisId (no smuggled target details)', () => {
  assert.equal(testerInputSchema.safeParse({ scanId: SCAN_ID, hypothesisId: HYP_ID }).success, true);
  assert.equal(
    testerInputSchema.safeParse({ scanId: SCAN_ID, hypothesisId: HYP_ID, url: 'https://evil.example.com' }).success,
    false,
  );
});

test('jwt observation carries the three-way baseline + mutations, discriminated by class', () => {
  const obs = testerObservationSchema.parse({
    vulnClass: 'jwt',
    oracleUrl: 'https://app.example.com/api/me',
    noToken: sig(401),
    validToken: sig(200),
    mutations: [{ kind: 'alg_none', signal: sig(200) }],
  });
  assert.equal(obs.vulnClass, 'jwt');
});

test('injection observation carries baseline vs injected + matched error pattern names (not raw text)', () => {
  const obs = testerObservationSchema.parse({
    vulnClass: 'injection',
    param: { name: 'q', location: 'query' },
    attempts: [
      {
        injectionClass: 'sqli_error',
        payloadFamily: 'single-quote',
        baseline: sig(200),
        injected: sig(500),
        matchedErrorPatterns: ['postgres_syntax_error'],
      },
    ],
  });
  assert.equal(obs.vulnClass, 'injection');
});

test('ssrf observation carries the OOB token (confirmation is out-of-band, not a socket)', () => {
  const obs = testerObservationSchema.parse({
    vulnClass: 'ssrf',
    param: { name: 'url', location: 'query' },
    oobToken: 'tok-abc123',
    sent: true,
    sentAt: 1_000_000,
  });
  assert.equal(obs.vulnClass, 'ssrf');
});

test('idor observation carries both privilege-level signals', () => {
  const obs = testerObservationSchema.parse({
    vulnClass: 'idor',
    endpoint: 'https://app.example.com/api/orders/42',
    method: 'GET',
    lowPrivilege: sig(403),
    highPrivilege: sig(200),
  });
  assert.equal(obs.vulnClass, 'idor');
});

test('no observation can assert a verdict — an unknown vuln class is rejected', () => {
  assert.equal(testerObservationSchema.safeParse({ vulnClass: 'xss' }).success, false);
});
