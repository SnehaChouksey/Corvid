import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { httpSendInputSchema, httpSendOutputSchema } from '../src/index.ts';

const SCAN_ID = '11111111-1111-4111-8111-111111111111';

test('http.send input requires a uuid scanId + method + url, and rejects unknown keys', () => {
  const ok = httpSendInputSchema.safeParse({ scanId: SCAN_ID, method: 'GET', url: 'https://app.example.com/api/x' });
  assert.equal(ok.success, true);
  // A caller must not be able to smuggle scope/authorization — it is derived from the target row.
  const smuggled = httpSendInputSchema.safeParse({
    scanId: SCAN_ID,
    method: 'GET',
    url: 'https://app.example.com/api/x',
    scopeRules: { hosts: ['evil.example.com'] },
  });
  assert.equal(smuggled.success, false);
  assert.equal(httpSendInputSchema.safeParse({ scanId: 'nope', method: 'GET', url: 'x' }).success, false);
});

test('http.send output round-trips a sent response', () => {
  const parsed = httpSendOutputSchema.parse({
    outcome: 'sent',
    response: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}', timingMs: 42 },
  });
  assert.equal(parsed.outcome, 'sent');
  if (parsed.outcome === 'sent') assert.equal(parsed.response.status, 200);
});

test('http.send output models an out-of-scope refusal and a dedup skip (no response body)', () => {
  assert.equal(httpSendOutputSchema.parse({ outcome: 'refused_out_of_scope' }).outcome, 'refused_out_of_scope');
  assert.equal(httpSendOutputSchema.parse({ outcome: 'deduplicated' }).outcome, 'deduplicated');
  // A refusal carries no response — a refused request never reached the network.
  assert.equal(httpSendOutputSchema.safeParse({ outcome: 'refused_out_of_scope', response: {} }).success, false);
});
