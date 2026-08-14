import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { InjectionObservation, ResponseSignal } from '@corvid/tool-contracts';

import { verifyInjection } from '../src/index.ts';

function sig(timingMs: number, status = 200): ResponseSignal {
  return { status, bodyLength: 200, timingMs, bodyHash: `h${timingMs}` };
}

type Attempt = InjectionObservation['attempts'][number];

function attempt(
  injectionClass: Attempt['injectionClass'],
  payloadFamily: string,
  matchedErrorPatterns: string[],
  baselineMs: number,
  injectedMs: number,
): Attempt {
  return { injectionClass, payloadFamily, baseline: sig(baselineMs), injected: sig(injectedMs), matchedErrorPatterns };
}

function obs(attempts: Attempt[]): InjectionObservation {
  return { vulnClass: 'injection', param: { name: 'q', location: 'query' }, attempts };
}

// ---- error-based ----

test('verified (error-based): a metacharacter errors while the neutralized control does not', () => {
  const result = verifyInjection(
    obs([
      attempt('sqli_error', 'single-quote', [], 10, 12),
      attempt('sqli_error', 'paren-breakout', ['sqlite'], 10, 14),
      attempt('sqli_error', 'escaped-control', [], 10, 11),
    ]),
  );
  assert.equal(result.kind, 'verified');
  if (result.kind === 'verified') assert.match(result.proof.summary, /error-based/);
});

test('not_confirmed: the control ALSO errors — the error is not attributable to the metacharacter', () => {
  // The app errors on any quote (control included) → not our injection. The classic FP.
  const result = verifyInjection(
    obs([
      attempt('sqli_error', 'paren-breakout', ['sqlite'], 10, 14),
      attempt('sqli_error', 'escaped-control', ['sqlite'], 10, 13),
    ]),
  );
  assert.equal(result.kind, 'not_confirmed');
});

// ---- time-based dose-response ----

test('verified (time-based): latency scales with the injected delay (4s ≈ 2× 2s)', () => {
  const result = verifyInjection(
    obs([
      attempt('sqli_time', 'pg-sleep-2s', [], 10, 2010), // delay ≈ 2000
      attempt('sqli_time', 'pg-sleep-4s', [], 10, 4010), // delay ≈ 4000
    ]),
  );
  assert.equal(result.kind, 'verified');
  if (result.kind === 'verified') assert.match(result.proof.summary, /time-based/);
});

test('not_confirmed: a single slow response that does NOT scale is not a dose-response', () => {
  // Both sleeps came back ~2s — jitter/one slow response, not latency scaling with the dose.
  const result = verifyInjection(
    obs([
      attempt('sqli_time', 'pg-sleep-2s', [], 10, 2010),
      attempt('sqli_time', 'pg-sleep-4s', [], 10, 2110),
    ]),
  );
  assert.equal(result.kind, 'not_confirmed');
});

test('not_confirmed: no DB error and no timing scaling', () => {
  const result = verifyInjection(
    obs([
      attempt('sqli_error', 'single-quote', [], 10, 12),
      attempt('sqli_error', 'escaped-control', [], 10, 11),
      attempt('nosqli', 'ne-operator', [], 10, 13),
    ]),
  );
  assert.equal(result.kind, 'not_confirmed');
});
