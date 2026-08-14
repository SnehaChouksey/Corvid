import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createHttpSend, type FetchRequest, type HttpSendPorts } from '@corvid/http-send';
import type { HttpResponse } from '@corvid/tool-contracts';
import { verifyIdor, verifyInjection, verifyJwt } from '@corvid/verify';

import { idorCompare, injectionFuzz, jwtMutateTest } from '../src/index.ts';

// Opt-in real-target integration tests against a local OWASP Juice Shop — proof the testers gather a
// real signal, not just a fake one. To run:
//   docker run -d -p 3000:3000 bkimminich/juice-shop
//   JUICESHOP_URL=http://localhost:3000 node --test   (from packages/testers)
// Each test drives the REAL http.send with a real fetch (in-memory scope/dedup — no DB/E2B needed
// for a local lab you own) against a genuinely vulnerable endpoint.

const JUICESHOP_URL = process.env.JUICESHOP_URL;
const DUMMY_SCAN = '00000000-0000-4000-8000-000000000000';
const PASSWORD = 'Passw0rd!1';

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

/** Register (idempotent — ignores "already exists") then log in, returning the JWT + basket id. */
async function login(baseUrl: string, email: string): Promise<{ token: string; bid: number }> {
  await fetch(`${baseUrl}/api/Users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, passwordRepeat: PASSWORD, securityQuestion: { id: 2 }, securityAnswer: 'cat' }),
  }).catch(() => undefined);
  const res = await fetch(`${baseUrl}/rest/user/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const json = (await res.json()) as { authentication: { token: string; bid: number } };
  return { token: json.authentication.token, bid: json.authentication.bid };
}

if (JUICESHOP_URL === undefined) {
  test('juice-shop integration (skipped — set JUICESHOP_URL to run)', { skip: true }, () => {});
} else {
  const baseUrl = JUICESHOP_URL;

  test('injection.fuzz elicits a real error-based SQLi signal, and the control does not error', async () => {
    const send = localSender(baseUrl);
    const outcome = await injectionFuzz(send, {
      target: { scanId: DUMMY_SCAN, url: `${baseUrl}/rest/products/search?q=apple`, method: 'GET' },
      param: { name: 'q', location: 'query' },
    });

    assert.equal(outcome.kind, 'observed');
    if (outcome.kind !== 'observed') return;
    const errored = outcome.observation.attempts.filter((a) => a.matchedErrorPatterns.length > 0);
    assert.ok(errored.length > 0, 'expected at least one payload to elicit a DB error');
    assert.ok(errored.every((a) => a.injectionClass === 'sqli_error'), 'errors should come only from error-based payloads');
    const control = outcome.observation.attempts.find((a) => a.payloadFamily === 'escaped-control');
    assert.ok(control, 'expected an escaped-control attempt');
    assert.deepEqual(control?.matchedErrorPatterns, []); // the false-positive guard

    // End-to-end: the deterministic verifier turns the observation into a CONFIRMED finding.
    const verdict = verifyInjection(outcome.observation);
    assert.equal(verdict.kind, 'verified', `injection verdict: ${verdict.kind}`);
  });

  test('jwt.mutate_test gathers the three-way auth-state signal on a real JWT oracle', async () => {
    const send = localSender(baseUrl);
    const a = await login(baseUrl, 'corvid-a@test.local');
    // /rest/basket/{bid} is a clean oracle: 401 with no token, 200 with a valid one.
    const outcome = await jwtMutateTest(send, {
      target: { scanId: DUMMY_SCAN, url: `${baseUrl}/rest/basket/${a.bid}`, method: 'GET' },
      sampleJwt: a.token,
    });

    assert.equal(outcome.kind, 'observed');
    if (outcome.kind !== 'observed') return;
    // The oracle must distinguish sessions (the D-13 precondition): no-token ≠ valid-token.
    assert.equal(outcome.observation.noToken.status, 401);
    assert.equal(outcome.observation.validToken.status, 200);
    assert.ok(outcome.observation.mutations.some((m) => m.kind === 'alg_none'), 'expected the alg:none forgery to be attempted');

    // End-to-end: run the deterministic verifier on the real observation. This is the definitive
    // answer to "is this JWT forgeable?" — it is verified ONLY if a forged token got the authed
    // response distinct from no-token. Either verdict is a real result (Juice Shop's version varies).
    const verdict = verifyJwt(outcome.observation);
    assert.ok(verdict.kind === 'verified' || verdict.kind === 'not_confirmed', `jwt verdict was ${verdict.kind}`);
  });

  test('idor.compare — a low-priv session reads the victim’s ACTUAL basket, not merely a 200', async () => {
    const send = localSender(baseUrl);
    const attacker = await login(baseUrl, 'corvid-a@test.local');
    const victim = await login(baseUrl, 'corvid-b@test.local');
    // Give the victim's basket a distinctive item so "A saw B's data" is unambiguous (idempotent-ish;
    // a duplicate add just increases quantity).
    await fetch(`${baseUrl}/api/BasketItems`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${victim.token}` },
      body: JSON.stringify({ ProductId: 1, BasketId: victim.bid, quantity: 1 }),
    }).catch(() => undefined);

    const outcome = await idorCompare(send, {
      target: { scanId: DUMMY_SCAN, url: `${baseUrl}/rest/basket/${victim.bid}`, method: 'GET' },
      lowPrivilege: { headers: { authorization: `Bearer ${attacker.token}` } },
      highPrivilege: { headers: { authorization: `Bearer ${victim.token}` } },
      // D-15 controls, under the attacker's session: its OWN basket (should succeed, different data)
      // and a non-existent id (should fail).
      ownResourceUrl: `${baseUrl}/rest/basket/${attacker.bid}`,
      absentResourceUrl: `${baseUrl}/rest/basket/9999999`,
    });

    assert.equal(outcome.kind, 'observed');
    if (outcome.kind !== 'observed') return;
    assert.equal(outcome.observation.lowPrivilege.status, 200);
    assert.equal(outcome.observation.highPrivilege.status, 200);
    // The attacker's response is byte-identical to the owner's → it read the victim's real basket.
    assert.equal(outcome.observation.lowPrivilege.bodyHash, outcome.observation.highPrivilege.bodyHash);

    // End-to-end: the verifier confirms the IDOR only with the D-15 controls holding (attacker read
    // the victim's data, distinct from its own; a non-existent id was denied).
    const verdict = verifyIdor(outcome.observation);
    assert.equal(verdict.kind, 'verified', `idor verdict: ${verdict.kind}`);
  });
}
