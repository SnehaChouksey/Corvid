import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { crawlerMapInputSchema, crawlerMapOutputSchema } from '../src/index.ts';

const SCAN_ID = '11111111-1111-4111-8111-111111111111';

test('crawler.map input applies conservative crawl bounds by default', () => {
  const parsed = crawlerMapInputSchema.parse({ scanId: SCAN_ID });
  assert.equal(parsed.maxPages, 200);
  assert.equal(parsed.maxDepth, 10);
});

test('crawler.map input rejects unknown keys (strict wire contract)', () => {
  const result = crawlerMapInputSchema.safeParse({
    scanId: SCAN_ID,
    // A client must not be able to smuggle scope/seed — those are derived from the recorded target.
    scopeRules: { hosts: ['app.example.com'] },
  });
  assert.equal(result.success, false);
});

test('crawler.map input requires a uuid scanId', () => {
  assert.equal(crawlerMapInputSchema.safeParse({ scanId: 'not-a-uuid' }).success, false);
  assert.equal(crawlerMapInputSchema.safeParse({}).success, false);
});

test('crawler.map output round-trips an endpoint + auth-flow map', () => {
  const output = {
    endpoints: [
      {
        url: 'https://app.example.com/api/users?id=1',
        method: 'GET' as const,
        source: 'xhr' as const,
        params: [{ name: 'id', location: 'query' as const }],
      },
    ],
    authFlows: [
      {
        kind: 'form_login' as const,
        url: 'https://app.example.com/login',
        formAction: 'https://app.example.com/session',
        method: 'POST' as const,
        fields: [
          { name: 'email', type: 'email' },
          { name: 'password', type: 'password' },
        ],
      },
    ],
    stats: { pagesVisited: 3, endpointsFound: 1, skippedOutOfScope: 2 },
  };
  const parsed = crawlerMapOutputSchema.parse(output);
  assert.equal(parsed.endpoints.length, 1);
  assert.equal(parsed.authFlows[0]?.kind, 'form_login');
  assert.equal(parsed.stats.skippedOutOfScope, 2);
});
