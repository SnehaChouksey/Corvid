import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { AuthorizationError } from '@corvid/errors';
import { parseScopeRules } from '@corvid/scope';

import {
  createTestingSandbox,
  type SandboxCreateOptions,
  type SandboxFactory,
} from '../src/sandbox.ts';

const oob = { host: 'oob.corvid.example' };
const scope = parseScopeRules({ hosts: ['app.example.com', 'api.example.com'] });

test('refuses to create a sandbox without recorded authorization — and never calls E2B (layer 1)', async () => {
  const calls: SandboxCreateOptions[] = [];
  const factory: SandboxFactory = {
    create: async (options) => {
      calls.push(options);
      return { sandboxId: 'x', writeFile: async () => {}, run: async () => ({ exitCode: 0, stdout: '', stderr: '' }), kill: async () => {} };
    },
  };

  await assert.rejects(
    createTestingSandbox(factory, { scope, oob, authorization: { confirmedAt: null } }),
    AuthorizationError,
  );
  assert.equal(calls.length, 0); // fail closed BEFORE any sandbox is created
});

test('with authorization, egress denies all and allows only scope hosts + OOB (layer 2)', async () => {
  const calls: SandboxCreateOptions[] = [];
  let killed = false;
  const factory: SandboxFactory = {
    create: async (options) => {
      calls.push(options);
      return {
        sandboxId: 'sbx_1',
        writeFile: async () => {},
        run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        kill: async () => void (killed = true),
      };
    },
  };

  const sandbox = await createTestingSandbox(factory, {
    scope,
    oob,
    authorization: { confirmedAt: new Date() },
    timeoutMs: 60_000,
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.network.denyOut, ['0.0.0.0/0']); // deny all
  assert.deepEqual(
    [...calls[0]!.network.allowOut].sort(),
    ['api.example.com', 'app.example.com', 'oob.corvid.example'], // target hosts + OOB only
  );
  assert.equal(calls[0]!.timeoutMs, 60_000);
  assert.deepEqual([...sandbox.allowOut].sort(), ['api.example.com', 'app.example.com', 'oob.corvid.example']);

  await sandbox.kill();
  assert.equal(killed, true);
});

// The live firewall proof (DoD: a deliberate out-of-scope egress is denied, asserted on an
// application-level signal not a socket open) requires a real E2B_API_KEY (Unit 0). Documented as
// pending-external rather than silently missing.
test('live E2B egress denial (pending E2B_API_KEY — Unit 0)', { skip: process.env.E2B_API_KEY === undefined }, () => {
  // Intentionally empty until a key exists; see AGENTS.md invariant on accept-then-drop.
});
