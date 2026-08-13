import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import { decodeJwt, mutateAlgNone, mutateHsRsConfusion, mutateKeyReuse } from '../src/index.ts';

const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
const payload = Buffer.from(JSON.stringify({ sub: 'user1', role: 'user' })).toString('base64url');
const SAMPLE = `${header}.${payload}.originalsignature`;

test('decodeJwt reads the header and payload', () => {
  const { header: h, payload: p } = decodeJwt(SAMPLE);
  assert.equal(h.alg, 'RS256');
  assert.equal(p.sub, 'user1');
});

test('mutateAlgNone sets alg=none, keeps the payload, and drops the signature', () => {
  const forged = mutateAlgNone(SAMPLE);
  const parts = forged.split('.');
  assert.equal(parts.length, 3);
  assert.equal(parts[2], ''); // empty signature
  assert.equal(parts[1], payload); // payload unchanged
  assert.equal(decodeJwt(forged).header.alg, 'none');
  assert.equal(decodeJwt(forged).payload.sub, 'user1');
});

test('mutateHsRsConfusion re-signs with HS256 using the public key as the HMAC secret', () => {
  const forged = mutateHsRsConfusion(SAMPLE, 'PUBLIC_KEY_PEM');
  const [h, p, s] = forged.split('.');
  assert.equal(decodeJwt(forged).header.alg, 'HS256');
  const expected = createHmac('sha256', 'PUBLIC_KEY_PEM').update(`${h}.${p}`).digest('base64url');
  assert.equal(s, expected); // a real, verifiable HMAC
});

test('mutateKeyReuse re-signs with a candidate secret', () => {
  const forged = mutateKeyReuse(SAMPLE, 'weak-secret');
  const [h, p, s] = forged.split('.');
  const expected = createHmac('sha256', 'weak-secret').update(`${h}.${p}`).digest('base64url');
  assert.equal(s, expected);
});

test('a malformed token is rejected, not silently mutated', () => {
  assert.throws(() => mutateAlgNone('not-a-jwt'));
  assert.throws(() => decodeJwt('a.b'));
});
