import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createHttpSend, type FetchRequest, type HttpSendPorts } from '@corvid/http-send';
import type { HttpResponse } from '@corvid/tool-contracts';

import { injectionFuzz } from '../src/index.ts';

// Opt-in real-target integration test against a local OWASP Juice Shop — proof the testers gather a
// real signal, not just a fake one. To run:
//   docker run -d -p 3000:3000 bkimminich/juice-shop
//   JUICESHOP_URL=http://localhost:3000 node --test   (from packages/testers)
// It drives the REAL http.send with a real fetch (in-memory scope/dedup — no DB/E2B needed for a
// local lab you own) against the SQLi-vulnerable product search, and asserts the error-based signal
// AND the false-positive guard (the neutralized control must NOT error).

const JUICESHOP_URL = process.env.JUICESHOP_URL;

async function realFetch(req: FetchRequest): Promise<HttpResponse> {
  const startedAt = Date.now();
  const res = await fetch(req.url, {
    method: req.method,
    ...(req.headers !== undefined ? { headers: req.headers } : {}),
    ...(req.body !== undefined ? { body: req.body } : {}),
  });
  const body = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: res.status, headers, body, timingMs: Date.now() - startedAt };
}

function localSender(baseUrl: string): ReturnType<typeof createHttpSend>['send'] {
  const ports: HttpSendPorts = {
    resolveTarget: async () => ({ scope: { hosts: [new URL(baseUrl).hostname] }, authorized: true }),
    alreadySent: async () => false,
    markSent: async () => {},
    fetch: realFetch,
    audit: async () => {},
    sleep: async () => {},
    now: () => Date.now(),
  };
  return createHttpSend(ports).send;
}

if (JUICESHOP_URL === undefined) {
  test('juice-shop injection integration (skipped — set JUICESHOP_URL to run)', { skip: true }, () => {});
} else {
  const baseUrl = JUICESHOP_URL;
  test('injection.fuzz elicits a real error-based SQLi signal, and the control does not error', async () => {
    const send = localSender(baseUrl);
    const outcome = await injectionFuzz(send, {
      target: {
        scanId: '00000000-0000-4000-8000-000000000000',
        url: `${baseUrl}/rest/products/search?q=apple`,
        method: 'GET',
      },
      param: { name: 'q', location: 'query' },
    });

    assert.equal(outcome.kind, 'observed');
    if (outcome.kind !== 'observed') return;

    // At least one metacharacter payload elicits a DB error — the real SQLi signal.
    const errored = outcome.observation.attempts.filter((a) => a.matchedErrorPatterns.length > 0);
    assert.ok(errored.length > 0, 'expected at least one payload to elicit a DB error');
    assert.ok(errored.every((a) => a.injectionClass === 'sqli_error'), 'errors should come only from error-based payloads');

    // The neutralized control must NOT error — the false-positive guard the verifier relies on.
    const control = outcome.observation.attempts.find((a) => a.payloadFamily === 'escaped-control');
    assert.ok(control, 'expected an escaped-control attempt');
    assert.deepEqual(control?.matchedErrorPatterns, []);
  });
}
