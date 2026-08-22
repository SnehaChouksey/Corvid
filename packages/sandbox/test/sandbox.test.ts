import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { AuthorizationError } from '@corvid/errors';
import { parseScopeRules } from '@corvid/scope';

import { createE2bSandboxFactory } from '../src/e2b.ts';
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

// The live firewall proof (Unit 8 safety-audit DoD: a deliberate out-of-scope egress is DENIED,
// asserted on an APPLICATION-LEVEL signal — an HTTP response that never arrives — not a socket open,
// because E2B can accept-then-drop a denied egress, §7/AGENTS.md). Opt-in via a real E2B_API_KEY.
//
// The probe runs INSIDE the egress-restricted sandbox and attempts two fetches: one to the single
// in-scope host (must complete with a status) and one to an out-of-scope host (must fail to return
// any HTTP response within a bounded timeout). We assert on those app-level outcomes, never on a
// connect() result.
const E2B_API_KEY = process.env.E2B_API_KEY;
test('live E2B egress: in-scope reachable, out-of-scope denied (app-level signal)', { skip: E2B_API_KEY === undefined }, async () => {
  const apiKey = E2B_API_KEY!;
  // Scope allows ONLY example.com (+ the OOB host); example.org is deliberately out of scope.
  const escopeScope = parseScopeRules({ hosts: ['example.com'] });
  const sandbox = await createTestingSandbox(createE2bSandboxFactory(apiKey), {
    scope: escopeScope,
    oob: { host: 'oob.invalid' },
    authorization: { confirmedAt: new Date() },
    timeoutMs: 90_000,
  });

  try {
    assert.deepEqual([...sandbox.allowOut].sort(), ['example.com', 'oob.invalid']); // deny-all + these

    // A CommonJS probe (Node 20 in the sandbox; `fetch` is global). A denied egress may hang, so each
    // fetch is bounded — a timeout/abort proves "no HTTP response", the correct app-level signal.
    const probe = [
      'const BEGIN = "__EGRESS_BEGIN__", END = "__EGRESS_END__";',
      'async function probe(url) {',
      '  try {',
      '    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });',
      '    return { responded: true, status: res.status };',
      '  } catch (e) {',
      '    return { responded: false, error: String((e && e.name) || e) };',
      '  }',
      '}',
      '(async () => {',
      '  const inScope = await probe("https://example.com/");',
      '  const outOfScope = await probe("https://example.org/");',
      '  console.log(BEGIN + JSON.stringify({ inScope, outOfScope }) + END);',
      '})();',
    ].join('\n');
    await sandbox.writeFile('/home/user/egress-probe.cjs', probe);
    const result = await sandbox.run('node /home/user/egress-probe.cjs');

    const start = result.stdout.indexOf('__EGRESS_BEGIN__');
    const end = result.stdout.indexOf('__EGRESS_END__');
    assert.ok(start !== -1 && end > start, `probe produced no parseable output: ${result.stdout} ${result.stderr}`);
    const parsed = JSON.parse(result.stdout.slice(start + '__EGRESS_BEGIN__'.length, end)) as {
      inScope: { responded: boolean; status?: number };
      outOfScope: { responded: boolean; error?: string };
    };

    // In-scope: the request completed and returned an HTTP status (application-level reachability).
    assert.equal(parsed.inScope.responded, true, 'the in-scope host must be reachable through the allow-list');
    assert.equal(typeof parsed.inScope.status, 'number');
    // Out-of-scope: NO HTTP response ever arrived — the egress was denied at the firewall.
    assert.equal(parsed.outOfScope.responded, false, 'an out-of-scope egress must NOT return an HTTP response');
  } finally {
    await sandbox.kill();
  }
});
