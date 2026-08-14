import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

import { isCorvidError } from '@corvid/errors';

import { createCipher, loadKey } from '../src/index.ts';

const KEY = randomBytes(32);

test('round-trips UTF-8 plaintext', () => {
  const cipher = createCipher(KEY);
  const secret = JSON.stringify({ jwtSample: 'eyJ...', pw: 'p@ss🔐' });
  assert.equal(cipher.decrypt(cipher.encrypt(secret)), secret);
});

test('two encryptions of the same plaintext differ (random IV)', () => {
  const cipher = createCipher(KEY);
  assert.notEqual(cipher.encrypt('same'), cipher.encrypt('same'));
});

test('a tampered ciphertext fails to decrypt (GCM authentication)', () => {
  const cipher = createCipher(KEY);
  const token = cipher.encrypt('sensitive');
  const parts = token.split('.');
  // Flip a byte in the ciphertext segment.
  const ct = Buffer.from(parts[3]!, 'base64url');
  ct[0] = (ct[0] ?? 0) ^ 0xff;
  parts[3] = ct.toString('base64url');
  assert.throws(() => cipher.decrypt(parts.join('.')));
});

test('a different key cannot decrypt', () => {
  const token = createCipher(KEY).encrypt('sensitive');
  assert.throws(() => createCipher(randomBytes(32)).decrypt(token));
});

test('malformed tokens are rejected', () => {
  const cipher = createCipher(KEY);
  assert.throws(() => cipher.decrypt('not-a-token'));
  assert.throws(() => cipher.decrypt('v9.aaa.bbb.ccc'));
});

test('loadKey fails closed on a non-32-byte key', () => {
  assert.throws(
    () => loadKey(Buffer.from('too-short').toString('base64')),
    (e) => isCorvidError(e) && e.kind === 'config',
  );
  // A valid 32-byte key loads.
  assert.equal(loadKey(randomBytes(32).toString('base64')).length, 32);
});
