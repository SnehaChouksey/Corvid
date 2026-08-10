import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  AuthorizationError,
  ConfigError,
  CorvidError,
  InfraError,
  TargetError,
  isCorvidError,
} from '../src/index.ts';

test('subclasses are both CorvidError and native Error, with the right name', () => {
  const err = new ConfigError('missing DATABASE_URL');
  assert.ok(err instanceof CorvidError);
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'ConfigError');
  assert.equal(err.message, 'missing DATABASE_URL');
});

test('kind and retryability match the §4 categories', () => {
  // Config and authorization are terminal — never retryable (§4).
  assert.deepEqual(
    [new ConfigError('x').kind, new ConfigError('x').retryable],
    ['config', false],
  );
  assert.deepEqual(
    [new AuthorizationError('out of scope').kind, new AuthorizationError('x').retryable],
    ['authorization', false],
  );
  // Target-side defaults to non-retryable; infra requires an explicit decision (fail-closed).
  assert.equal(new TargetError('429 from target').retryable, false);
  assert.equal(new InfraError('sandbox create failed', { retryable: true }).retryable, true);
  // ...and both honor the stated value.
  assert.equal(new TargetError('429', { retryable: true }).retryable, true);
  assert.equal(new InfraError('llm spend cap', { retryable: false }).retryable, false);
});

test('cause and context propagate; context defaults to empty', () => {
  const root = new Error('socket hang up');
  const err = new InfraError('oob listener unreachable', {
    retryable: true,
    cause: root,
    context: { scan_id: 'scan_123', component: 'oob' },
  });
  assert.equal(err.cause, root);
  assert.deepEqual(err.context, { scan_id: 'scan_123', component: 'oob' });
  assert.deepEqual(new ConfigError('x').context, {});
});

test('isCorvidError narrows only our errors', () => {
  assert.ok(isCorvidError(new TargetError('x')));
  assert.equal(isCorvidError(new Error('plain')), false);
  assert.equal(isCorvidError('not an error'), false);
  assert.equal(isCorvidError(null), false);
});
