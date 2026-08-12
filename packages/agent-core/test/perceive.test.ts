import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { CrawlerMapOutput } from '@corvid/tool-contracts';

import { perceive } from '../src/index.ts';

test('perceive merges duplicate method+url endpoints and unions their params', () => {
  const map: CrawlerMapOutput = {
    endpoints: [
      { url: 'https://a.example.com/x', method: 'GET', source: 'xhr', params: [{ name: 'a', location: 'query' }] },
      { url: 'https://a.example.com/x', method: 'GET', source: 'link', params: [{ name: 'b', location: 'query' }] },
      { url: 'https://a.example.com/x', method: 'POST', source: 'form', params: [] },
      { url: 'https://a.example.com/y', method: 'GET', source: 'navigation', params: [] },
    ],
    authFlows: [{ kind: 'form_login', url: 'https://a.example.com/login', fields: [] }],
    stats: { pagesVisited: 2, endpointsFound: 4, skippedOutOfScope: 0 },
  };

  const surface = perceive(map);

  // GET /x merged (2 → 1); POST /x is distinct (method differs); GET /y distinct → 3 endpoints.
  assert.equal(surface.endpoints.length, 3);
  const getX = surface.endpoints.find((e) => e.url === 'https://a.example.com/x' && e.method === 'GET');
  assert.equal(getX?.params.length, 2); // a + b unioned
  assert.equal(surface.stats.endpointCount, 3);
  assert.equal(surface.stats.parameterizedCount, 1); // only GET /x has params
  assert.equal(surface.stats.authFlowCount, 1);
});

test('perceive keeps the most informative source when merging duplicate endpoints', () => {
  const surface = perceive({
    endpoints: [
      { url: 'https://a.example.com/x', method: 'GET', source: 'link', params: [] },
      { url: 'https://a.example.com/x', method: 'GET', source: 'xhr', params: [] },
    ],
    authFlows: [],
    stats: { pagesVisited: 1, endpointsFound: 2, skippedOutOfScope: 0 },
  });
  assert.equal(surface.endpoints.length, 1);
  // xhr (a real request) is kept over link, even though link was discovered first.
  assert.equal(surface.endpoints[0]?.source, 'xhr');
});

test('perceive on an empty crawl map yields an empty surface', () => {
  const surface = perceive({
    endpoints: [],
    authFlows: [],
    stats: { pagesVisited: 0, endpointsFound: 0, skippedOutOfScope: 0 },
  });
  assert.equal(surface.endpoints.length, 0);
  assert.equal(surface.stats.endpointCount, 0);
});
