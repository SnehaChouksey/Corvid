import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { HttpSendOutput } from '@corvid/tool-contracts';

import { jwtMutateTest, type SendFn } from '../src/index.ts';

const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
const payload = Buffer.from(JSON.stringify({ sub: 'user1' })).toString('base64url');
const SAMPLE = `${header}.${payload}.sig`;

const target = { scanId: '11111111-1111-4111-8111-111111111111', url: 'https://app.example.com/api/me', method: 'GET' as const };

// An oracle that authenticates on ANY bearer token — simulates a broken JWT check, so a forged token
// elicits the authenticated response. The tester only records signals; the VERIFIER decides.
const permissiveOracle: SendFn = async (input): Promise<HttpSendOutput> => {
  const authed = input.headers?.authorization !== undefined;
  return {
    outcome: 'sent',
    response: { status: authed ? 200 : 401, headers: {}, body: authed ? 'welcome user1' : 'unauthorized', timingMs: 4 },
  };
};

test('jwt tester emits the three-way observation (no token / valid / forged)', async () => {
  const outcome = await jwtMutateTest(permissiveOracle, { target, sampleJwt: SAMPLE });
  assert.equal(outcome.kind, 'observed');
  if (outcome.kind === 'observed') {
    const o = outcome.observation;
    assert.equal(o.vulnClass, 'jwt');
    assert.equal(o.oracleUrl, target.url);
    assert.equal(o.noToken.status, 401);
    assert.equal(o.validToken.status, 200);
    assert.equal(o.mutations[0]?.kind, 'alg_none');
    assert.equal(o.mutations[0]?.signal.status, 200); // forged token got the authed response (the signal)
    assert.notEqual(o.noToken.bodyHash, o.validToken.bodyHash); // materially different — the discriminator
  }
});

test('confusion + key-reuse mutations are included only when the material is supplied', async () => {
  const outcome = await jwtMutateTest(permissiveOracle, {
    target,
    sampleJwt: SAMPLE,
    publicKeyPem: 'PUB',
    keyReuseSecret: 'weak',
  });
  assert.equal(outcome.kind, 'observed');
  if (outcome.kind === 'observed') {
    const kinds = outcome.observation.mutations.map((m) => m.kind);
    assert.deepEqual(kinds, ['alg_none', 'hs_rs_confusion', 'key_reuse']);
  }
});

test('a refusal from http.send surfaces as not_sent (never a fabricated signal)', async () => {
  const refuse: SendFn = async () => ({ outcome: 'refused_out_of_scope' });
  const outcome = await jwtMutateTest(refuse, { target, sampleJwt: SAMPLE });
  assert.equal(outcome.kind, 'not_sent');
  if (outcome.kind === 'not_sent') assert.equal(outcome.reason, 'refused_out_of_scope');
});
