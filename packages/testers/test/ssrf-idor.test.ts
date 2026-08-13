import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { HttpSendOutput } from '@corvid/tool-contracts';

import { idorCompare, ssrfCheck, type OobRegistrar, type SendFn } from '../src/index.ts';

const target = {
  scanId: '11111111-1111-4111-8111-111111111111',
  url: 'https://app.example.com/api/orders/42',
  method: 'GET' as const,
};

// ---- ssrf.check ----

const fakeOob: OobRegistrar = {
  register: async () => ({ token: 'tok-abc123', host: 'oob.corvid.test' }),
};

test('ssrf tester registers a token, injects the OOB URL into the param, and records it as sent', async () => {
  let sentUrl = '';
  const capture: SendFn = async (input): Promise<HttpSendOutput> => {
    sentUrl = input.url;
    return { outcome: 'sent', response: { status: 200, headers: {}, body: 'ok', timingMs: 5 } };
  };
  const outcome = await ssrfCheck(capture, fakeOob, {
    target: { ...target, url: 'https://app.example.com/api/fetch?target=x' },
    param: { name: 'target', location: 'query' },
  });
  assert.equal(outcome.kind, 'observed');
  if (outcome.kind === 'observed') {
    assert.equal(outcome.observation.vulnClass, 'ssrf');
    assert.equal(outcome.observation.oobToken, 'tok-abc123');
    assert.equal(outcome.observation.sent, true);
  }
  // The injected param value references the unique OOB token — that is what a callback will identify.
  assert.equal(new URL(sentUrl).searchParams.get('target'), 'http://tok-abc123.oob.corvid.test/');
});

test('ssrf records sent:false when http.send refuses (payload did not go out)', async () => {
  const refuse: SendFn = async () => ({ outcome: 'refused_out_of_scope' });
  const outcome = await ssrfCheck(refuse, fakeOob, { target, param: { name: 'target', location: 'query' } });
  assert.equal(outcome.kind, 'observed');
  if (outcome.kind === 'observed') assert.equal(outcome.observation.sent, false);
});

// ---- idor.compare ----

// A target that authorizes ANY session for order 42 — simulates a broken object-level check, so the
// low-privilege session gets the same authenticated response as the owner. The tester only records;
// the VERIFIER decides ownership.
const brokenObjectCheck: SendFn = async (input): Promise<HttpSendOutput> => {
  const who = input.headers?.cookie ?? 'anon';
  return { outcome: 'sent', response: { status: 200, headers: {}, body: `order 42 for ${who}`, timingMs: 6 } };
};

test('idor tester issues the same request under both sessions and emits both signals', async () => {
  const outcome = await idorCompare(brokenObjectCheck, {
    target,
    lowPrivilege: { headers: { cookie: 'session=attacker' } },
    highPrivilege: { headers: { cookie: 'session=owner' } },
  });
  assert.equal(outcome.kind, 'observed');
  if (outcome.kind === 'observed') {
    const o = outcome.observation;
    assert.equal(o.vulnClass, 'idor');
    assert.equal(o.endpoint, target.url);
    assert.equal(o.lowPrivilege.status, 200);
    assert.equal(o.highPrivilege.status, 200);
    // Bodies differ only by the echoed session, so their hashes differ — the verifier reasons on this.
    assert.notEqual(o.lowPrivilege.bodyHash, o.highPrivilege.bodyHash);
  }
});

test('idor surfaces not_sent if either session request is refused', async () => {
  const refuse: SendFn = async () => ({ outcome: 'refused_out_of_scope' });
  const outcome = await idorCompare(refuse, {
    target,
    lowPrivilege: { headers: { cookie: 'a' } },
    highPrivilege: { headers: { cookie: 'b' } },
  });
  assert.equal(outcome.kind, 'not_sent');
});
