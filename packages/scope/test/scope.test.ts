import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { AuthorizationError } from '@corvid/errors';

import { deriveEgressAllowList, isUrlInScope, parseScopeRules } from '../src/index.ts';

const oob = { host: 'oob.corvid.example' };

test('parseScopeRules accepts valid rules and rejects empty/invalid scope (fail closed)', () => {
  const scope = parseScopeRules({ hosts: ['app.example.com'] });
  assert.deepEqual(scope.hosts, ['app.example.com']);

  assert.throws(() => parseScopeRules({ hosts: [] }), AuthorizationError);
  assert.throws(() => parseScopeRules({}), AuthorizationError);
  assert.throws(() => parseScopeRules(null), AuthorizationError);
});

test('deriveEgressAllowList = target hosts + OOB, deduped and lowercased', () => {
  const scope = parseScopeRules({ hosts: ['App.Example.com', 'api.example.com', 'app.example.com'] });
  const allow = deriveEgressAllowList(scope, oob);
  assert.deepEqual([...allow].sort(), ['api.example.com', 'app.example.com', 'oob.corvid.example']);
});

test('isUrlInScope matches host and fails closed on a bad URL / off-scope host', () => {
  const scope = parseScopeRules({ hosts: ['app.example.com'] });
  assert.equal(isUrlInScope('https://app.example.com/login', scope), true);
  assert.equal(isUrlInScope('https://APP.example.com/login', scope), true); // case-insensitive host
  assert.equal(isUrlInScope('https://evil.com/', scope), false); // off-scope host
  assert.equal(isUrlInScope('not-a-url', scope), false); // unparseable → out of scope
});

test('path include/exclude rules gate URLs on an in-scope host (ADR-24)', () => {
  const scope = parseScopeRules({
    hosts: ['app.example.com'],
    includePaths: ['/api/'],
    excludePaths: ['/api/admin'],
  });
  assert.equal(isUrlInScope('https://app.example.com/api/users', scope), true);
  assert.equal(isUrlInScope('https://app.example.com/api/admin/reset', scope), false); // excluded
  assert.equal(isUrlInScope('https://app.example.com/public', scope), false); // not in include set
});
