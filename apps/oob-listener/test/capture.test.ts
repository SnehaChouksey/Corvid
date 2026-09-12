import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { classifyPath } from '../src/capture.ts';

const TOKEN = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'; // 32 hex, a real token shape

test('a token-shaped first path segment is a callback carrying that token', () => {
  assert.deepEqual(classifyPath(`/${TOKEN}`), { kind: 'callback', token: TOKEN });
});

test('a callback on a deeper path still uses the first segment as the token', () => {
  assert.deepEqual(classifyPath(`/${TOKEN}/latest/meta-data/`), { kind: 'callback', token: TOKEN });
});

test('an uppercase token is normalized to the canonical lowercase token', () => {
  assert.deepEqual(classifyPath(`/${TOKEN.toUpperCase()}`), { kind: 'callback', token: TOKEN });
});

test('control paths are never token-shaped, so they fall through to the control routes', () => {
  assert.deepEqual(classifyPath('/register'), { kind: 'control' });
  assert.deepEqual(classifyPath('/callbacks/deadbeef'), { kind: 'control' });
});

test('a malformed first segment is never treated as a token (falls through)', () => {
  assert.deepEqual(classifyPath('/no'), { kind: 'control' }); // too short
  assert.deepEqual(classifyPath('/bad_token'), { kind: 'control' }); // underscore not allowed
  assert.deepEqual(classifyPath('/'), { kind: 'control' }); // root, no segment
  assert.deepEqual(classifyPath(''), { kind: 'control' });
});
