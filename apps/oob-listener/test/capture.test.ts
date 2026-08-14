import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { classifyHost } from '../src/capture.ts';

const OOB = 'oob.example.com';
const TOKEN = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'; // 32 hex, a real token shape

test('apex host is the control plane', () => {
  assert.deepEqual(classifyHost(OOB, OOB), { kind: 'control' });
});

test('a token subdomain is a callback carrying the leftmost label', () => {
  assert.deepEqual(classifyHost(`${TOKEN}.${OOB}`, OOB), { kind: 'callback', token: TOKEN });
});

test('a Host header port is stripped', () => {
  assert.deepEqual(classifyHost(`${TOKEN}.${OOB}:8080`, OOB), { kind: 'callback', token: TOKEN });
  assert.deepEqual(classifyHost(`${OOB}:80`, OOB), { kind: 'control' });
});

test('host matching is case-insensitive', () => {
  assert.deepEqual(classifyHost(`${TOKEN.toUpperCase()}.${OOB.toUpperCase()}`, OOB), {
    kind: 'callback',
    token: TOKEN,
  });
});

test('a foreign host is ignored (not ours)', () => {
  assert.deepEqual(classifyHost('evil.com', OOB), { kind: 'ignore' });
  assert.deepEqual(classifyHost(`${TOKEN}.evil.com`, OOB), { kind: 'ignore' });
});

test('a malformed token label is ignored (never treated as a token)', () => {
  assert.deepEqual(classifyHost(`no.${OOB}`, OOB), { kind: 'ignore' }); // too short
  assert.deepEqual(classifyHost(`bad_token.${OOB}`, OOB), { kind: 'ignore' }); // underscore not allowed
});

test('a missing or empty Host is ignored', () => {
  assert.deepEqual(classifyHost(undefined, OOB), { kind: 'ignore' });
  assert.deepEqual(classifyHost('', OOB), { kind: 'ignore' });
});
