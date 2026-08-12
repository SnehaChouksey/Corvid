import type { CrawledParam, CrawlerMapOutput, EndpointSource } from '@corvid/tool-contracts';

import type { PerceivedEndpoint, PerceivedSurface } from './types.ts';

// perceive: consume the crawl map (Unit 2 output) and normalize it into the surface the LLM reasons
// over. Pure and deterministic — no LLM, no I/O. Endpoints are de-duplicated by method+url with
// their parameters unioned, so the model sees each route once with the full set of params observed.

function paramKey(p: CrawledParam): string {
  return `${p.location}:${p.name}`;
}

// When the same method+url is discovered via several sources, keep the most informative one: an
// actual request/action (xhr/fetch/form — an API-ish call) tells the model more than a bare link or
// a navigation. Provenance is otherwise lossy on merge (params are unioned, source is single-valued).
const SOURCE_RANK: Readonly<Record<EndpointSource, number>> = {
  xhr: 3,
  fetch: 3,
  form: 2,
  link: 1,
  navigation: 1,
};

function preferredSource(current: EndpointSource, incoming: EndpointSource): EndpointSource {
  return SOURCE_RANK[incoming] > SOURCE_RANK[current] ? incoming : current;
}

export function perceive(map: CrawlerMapOutput): PerceivedSurface {
  const byEndpoint = new Map<string, { endpoint: PerceivedEndpoint; params: Map<string, CrawledParam> }>();

  for (const e of map.endpoints) {
    const key = `${e.method} ${e.url}`;
    let entry = byEndpoint.get(key);
    if (entry === undefined) {
      entry = {
        endpoint: { url: e.url, method: e.method, source: e.source, params: [] },
        params: new Map<string, CrawledParam>(),
      };
      byEndpoint.set(key, entry);
    } else {
      // Keep the most informative provenance across duplicates, don't silently drop it.
      entry.endpoint = { ...entry.endpoint, source: preferredSource(entry.endpoint.source, e.source) };
    }
    for (const p of e.params) entry.params.set(paramKey(p), p);
  }

  const endpoints: PerceivedEndpoint[] = [...byEndpoint.values()].map((entry) => ({
    ...entry.endpoint,
    params: [...entry.params.values()],
  }));

  const authFlows = map.authFlows.map((f) => ({ kind: f.kind, url: f.url }));

  return {
    endpoints,
    authFlows,
    stats: {
      endpointCount: endpoints.length,
      parameterizedCount: endpoints.filter((e) => e.params.length > 0).length,
      authFlowCount: authFlows.length,
    },
  };
}
