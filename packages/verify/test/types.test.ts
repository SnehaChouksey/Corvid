import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { DEFAULT_SEVERITY, notConfirmed } from '../src/index.ts';

test('the verification gate does NOT depend on an LLM client (ADR-01, enforced structurally)', () => {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- reads this package's own manifest
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  // The whole product rests on verification being non-LLM. If this ever fails, the boundary broke.
  assert.equal(deps['@corvid/llm'], undefined, '@corvid/verify must never import @corvid/llm');
});

test('DEFAULT_SEVERITY carries a CVSS 3.1 score + vector for every vuln class', () => {
  for (const cls of ['jwt', 'ssrf', 'injection', 'idor'] as const) {
    assert.match(DEFAULT_SEVERITY[cls], /^[0-9]/); // starts with the base score
    assert.ok(DEFAULT_SEVERITY[cls].includes('CVSS:3.1/'), `${cls} carries a CVSS 3.1 vector`);
  }
});

test('notConfirmed builds a not_confirmed verdict carrying the reason', () => {
  const result = notConfirmed('the forged token did not elicit the authenticated response');
  assert.equal(result.kind, 'not_confirmed');
  if (result.kind === 'not_confirmed') assert.match(result.reason, /forged token/);
});
