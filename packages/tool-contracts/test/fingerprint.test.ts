import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { fingerprint, normalizePath, type FingerprintInput } from '../src/index.ts';

const base: FingerprintInput = {
  vulnClass: 'injection',
  method: 'GET',
  url: 'https://app.example.com/api/users/42/posts',
  paramName: 'q',
  payloadFamily: 'sql-error',
};

test('normalizePath templates id-like segments and drops query + trailing slash', () => {
  assert.equal(normalizePath('https://app.example.com/api/users/42/posts/'), '/api/users/{id}/posts');
  assert.equal(normalizePath('https://app.example.com/api/users/99/posts'), '/api/users/{id}/posts');
  assert.equal(
    normalizePath('https://app.example.com/api/users/550e8400-e29b-41d4-a716-446655440000'),
    '/api/users/{id}',
  );
  assert.equal(normalizePath('https://app.example.com/search?q=1'), '/search');
  assert.equal(normalizePath('https://app.example.com/'), '/');
});

test('same weakness with different record ids fingerprints identically (endpoint collapse)', () => {
  const a = fingerprint({ ...base, url: 'https://app.example.com/api/users/1/posts' });
  const b = fingerprint({ ...base, url: 'https://app.example.com/api/users/2/posts' });
  assert.equal(a, b);
});

test('a trailing slash and a query string do not change the fingerprint', () => {
  const a = fingerprint(base);
  const b = fingerprint({ ...base, url: `${base.url}/?q=1` });
  assert.equal(a, b);
});

test('a variant payload in the same family dedups; a different family does not', () => {
  const errorBased = fingerprint({ ...base, payloadFamily: 'sql-error' });
  const errorBasedAgain = fingerprint({ ...base, payloadFamily: 'sql-error' });
  const timeBased = fingerprint({ ...base, payloadFamily: 'sql-time' });
  assert.equal(errorBased, errorBasedAgain);
  assert.notEqual(errorBased, timeBased);
});

test('a different class, method, param, or endpoint yields a different fingerprint', () => {
  const ref = fingerprint(base);
  assert.notEqual(ref, fingerprint({ ...base, vulnClass: 'idor' }));
  assert.notEqual(ref, fingerprint({ ...base, method: 'POST' }));
  assert.notEqual(ref, fingerprint({ ...base, paramName: 'id' }));
  assert.notEqual(ref, fingerprint({ ...base, url: 'https://app.example.com/api/accounts/42/posts' }));
});

test('a class-level (no-param) fingerprint is stable, and method casing is normalized', () => {
  const noParam: FingerprintInput = {
    vulnClass: base.vulnClass,
    method: base.method,
    url: base.url,
    payloadFamily: base.payloadFamily,
  };
  assert.equal(fingerprint(noParam), fingerprint(noParam));
  // A lowercase method matches its uppercase form (methods are normalized before hashing).
  assert.equal(fingerprint(base), fingerprint({ ...base, method: 'get' as FingerprintInput['method'] }));
});

test('fingerprint is a 64-char hex sha-256 digest', () => {
  assert.match(fingerprint(base), /^[0-9a-f]{64}$/);
});
