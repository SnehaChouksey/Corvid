import { AuthorizationError } from '@corvid/errors';
import type { CorvidLogger } from '@corvid/logger';
import { isUrlInScope, type ScopeRules } from '@corvid/scope';
import type {
  AuthFlow,
  CrawledEndpoint,
  CrawledParam,
  CrawlerMapOutput,
  EndpointSource,
  HttpMethod,
  ParamLocation,
} from '@corvid/tool-contracts';

import { normalizeUrl } from './normalize.ts';

// The crawl engine (`02` §10 `crawler.map`). Passive and autonomous (`01` §5) — it observes the
// rendered attack surface and never sends a payload. Two safety properties are load-bearing and
// tested deterministically here (against a fake fetcher, no browser):
//   1. It never issues an out-of-scope request. The fetcher aborts an out-of-scope request BEFORE
//      it leaves the browser; the engine also never enqueues an out-of-scope link. Scope is the
//      ONE @corvid/scope source (ADR-24), used identically for both.
//   2. Every crawl start/refusal/completion is audited (ADR-16), so a reviewer can verify across a
//      run that nothing out of scope was sent.
// The engine is decoupled from Playwright behind PageFetcher so the loop, scope gating, dedup, and
// audit are testable without a browser; the real fetcher lives in ./fetch.ts.

/** A request the page attempted, as observed by the fetcher. `resourceType` is Playwright's. */
export interface ObservedRequest {
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
}

export interface ObservedForm {
  readonly action: string;
  readonly method: string;
  readonly fields: ReadonlyArray<{ readonly name: string; readonly type: string }>;
}

export interface PageResult {
  readonly finalUrl: string;
  /** Absolute hrefs discovered in the rendered DOM. */
  readonly links: readonly string[];
  readonly forms: readonly ObservedForm[];
  /** In-scope requests the page actually sent. */
  readonly sentRequests: readonly ObservedRequest[];
  /** Out-of-scope requests aborted BEFORE leaving the browser (never sent). */
  readonly blockedRequests: readonly ObservedRequest[];
}

/**
 * Fetches one page. The implementation MUST abort any request whose URL fails `isAllowed` before it
 * leaves the browser and report it in `blockedRequests` — that abort is what makes the crawl unable
 * to issue an out-of-scope request while running outside the sandbox (v1, ADR-22 sandbox is the
 * testing-burst; the crawl is passive).
 */
export interface PageFetcher {
  fetchPage(url: string, isAllowed: (u: string) => boolean): Promise<PageResult>;
}

export interface FrontierItem {
  readonly url: string;
  readonly depth: number;
}

/** Minimal frontier surface the loop needs; @corvid/redis's CrawlFrontier satisfies it structurally. */
export interface Frontier {
  enqueue(items: readonly FrontierItem[]): Promise<number>;
  dequeue(): Promise<FrontierItem | null>;
}

export interface CrawlAuditEntry {
  readonly scanId: string;
  readonly action: string;
  readonly detail?: string;
}

/** Where crawl accountability lands (ADR-16). Real impl wraps @corvid/db `appendAudit`. */
export interface AuditSink {
  append(entry: CrawlAuditEntry): Promise<void>;
}

export interface CrawlDeps {
  readonly fetcher: PageFetcher;
  readonly frontier: Frontier;
  readonly audit: AuditSink;
  readonly logger: CorvidLogger;
}

interface MutableEndpoint {
  url: string;
  method: HttpMethod;
  source: EndpointSource;
  params: Map<string, ParamLocation>;
}

const HTTP_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);

/** Only these resource types are attack surface; assets (script/img/css/font/media) are noise. */
function endpointSourceFor(resourceType: string): EndpointSource | null {
  switch (resourceType) {
    case 'document':
      return 'navigation';
    case 'xhr':
      return 'xhr';
    case 'fetch':
      return 'fetch';
    default:
      return null;
  }
}

function toHttpMethod(raw: string): HttpMethod {
  const upper = raw.toUpperCase();
  return HTTP_METHODS.has(upper) ? (upper as HttpMethod) : 'GET';
}

/** Endpoint identity collapses query values: method + origin + pathname. */
function endpointKey(method: HttpMethod, url: URL): string {
  return `${method} ${url.origin}${url.pathname}`;
}

function upsertEndpoint(
  endpoints: Map<string, MutableEndpoint>,
  rawUrl: string,
  method: HttpMethod,
  source: EndpointSource,
): MutableEndpoint | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const key = endpointKey(method, url);
  let ep = endpoints.get(key);
  if (ep === undefined) {
    ep = { url: `${url.origin}${url.pathname}`, method, source, params: new Map() };
    endpoints.set(key, ep);
  }
  for (const name of url.searchParams.keys()) {
    if (!ep.params.has(name)) ep.params.set(name, 'query');
  }
  return ep;
}

function finalizeEndpoint(ep: MutableEndpoint): CrawledEndpoint {
  const params: CrawledParam[] = [...ep.params.entries()].map(([name, location]) => ({
    name,
    location,
  }));
  return { url: ep.url, method: ep.method, source: ep.source, params };
}

function recordForm(endpoints: Map<string, MutableEndpoint>, form: ObservedForm): void {
  const method = toHttpMethod(form.method);
  const ep = upsertEndpoint(endpoints, form.action, method, 'form');
  if (ep === null) return;
  // A form's fields ride in the body for a mutating method, else on the query string.
  const location: ParamLocation = method === 'GET' || method === 'HEAD' ? 'query' : 'body';
  for (const field of form.fields) {
    if (field.name.length > 0 && !ep.params.has(field.name)) ep.params.set(field.name, location);
  }
}

/** Detect a login flow to MAP (not replay — replay waits on D-1 creds, Unit 6). Caller guarantees
 * `form.action` is in scope before calling, so the emitted flow never references an out-of-scope
 * host (which Unit 6 would otherwise try to replay against). */
function detectAuthFlow(pageUrl: string, form: ObservedForm): AuthFlow | null {
  const hasPassword = form.fields.some((f) => f.type.toLowerCase() === 'password');
  if (!hasPassword) return null;
  return {
    kind: 'form_login',
    url: stripUrl(pageUrl),
    formAction: stripUrl(form.action),
    method: toHttpMethod(form.method),
    fields: form.fields.map((f) => ({ name: f.name, type: f.type })),
  };
}

/** Safe, structured audit detail — hosts + counts only, never a raw body or secret (§5). */
function safeDetail(data: Record<string, unknown>): string {
  return JSON.stringify(data);
}

/** Host + path only, query and userinfo dropped — safe to log/emit (a token can ride in a query). */
function safeUrlParts(raw: string): { host: string; path: string } {
  try {
    const u = new URL(raw);
    return { host: u.host, path: u.pathname };
  } catch {
    return { host: 'unparseable', path: '' };
  }
}

/** Drop query + userinfo from a URL, keeping origin + path — for values that reach the tool output. */
function stripUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return raw;
  }
}

// A hostile page can emit an unbounded link/host set; cap what we accumulate so one page can't
// exhaust heap or bloat an audit row (M6). These are ceilings, not expected sizes.
const MAX_ENDPOINTS = 5000;
const MAX_BLOCKED_HOSTS = 50;

/** Seed URL + bounds for a crawl. Derived server-side from the scan's target — never from a raw
 * tool argument (see the contract). `scope` is already validated by the caller. */
export interface CrawlParams {
  readonly scanId: string;
  readonly targetUrl: string;
  readonly maxPages: number;
  readonly maxDepth: number;
}

export async function crawl(
  params: CrawlParams,
  scope: ScopeRules,
  deps: CrawlDeps,
): Promise<CrawlerMapOutput> {
  const isAllowed = (u: string): boolean => isUrlInScope(u, scope);

  const seed = normalizeUrl(params.targetUrl);
  if (seed === null || !isAllowed(seed)) {
    await deps.audit.append({
      scanId: params.scanId,
      action: 'crawl.refused',
      detail: safeDetail({ reason: 'seed_out_of_scope' }),
    });
    throw new AuthorizationError('Seed URL is out of scope for the target');
  }

  await deps.audit.append({
    scanId: params.scanId,
    action: 'crawl.started',
    detail: safeDetail({
      host: new URL(seed).host,
      maxPages: params.maxPages,
      maxDepth: params.maxDepth,
    }),
  });
  await deps.frontier.enqueue([{ url: seed, depth: 0 }]);

  const endpoints = new Map<string, MutableEndpoint>();
  const authFlows: AuthFlow[] = [];
  const blockedHosts = new Set<string>();
  let pagesVisited = 0;
  let pagesAttempted = 0;
  let skippedOutOfScope = 0;

  try {
    // Bound on ATTEMPTS, not successes: a page that fails to load still consumes the budget, so a
    // flood of failing URLs can't run unbounded (H1).
    while (pagesAttempted < params.maxPages) {
      const item = await deps.frontier.dequeue();
      if (item === null) break;

      // Never trust a dequeued item: validate shape and re-check scope right here, so the loop is
      // self-sufficient and a corrupt/foreign frontier entry can neither crash it nor escape scope.
      if (typeof item.url !== 'string' || typeof item.depth !== 'number' || !isAllowed(item.url)) {
        skippedOutOfScope++;
        continue;
      }
      pagesAttempted++;

      let page: PageResult;
      try {
        page = await deps.fetcher.fetchPage(item.url, isAllowed);
      } catch (err) {
        // One page failing to load must not abort the whole crawl (a broken page is not a crawl
        // failure). Log SAFE fields only — a Playwright error message embeds the full URL incl.
        // query, which can carry a token (§5). The URL was already marked seen so it won't re-queue.
        const parts = safeUrlParts(item.url);
        deps.logger.warn(
          { err_name: err instanceof Error ? err.name : 'unknown', host: parts.host, path: parts.path },
          'crawl page fetch failed',
        );
        continue;
      }
      pagesVisited++;

      // The visited page is itself a GET navigation endpoint (independent of whether the fetcher
      // reported a document request). Guard on scope: a redirect could land finalUrl out of scope.
      if (isAllowed(page.finalUrl) && endpoints.size < MAX_ENDPOINTS) {
        upsertEndpoint(endpoints, page.finalUrl, 'GET', 'navigation');
      }

      for (const req of page.sentRequests) {
        const source = endpointSourceFor(req.resourceType);
        // Re-check scope even for "sent" requests: the engine never trusts the fetcher's
        // classification for a safety decision (defense in depth — H3).
        if (source !== null && isAllowed(req.url) && endpoints.size < MAX_ENDPOINTS) {
          upsertEndpoint(endpoints, req.url, toHttpMethod(req.method), source);
        }
      }
      for (const req of page.blockedRequests) {
        skippedOutOfScope++;
        if (blockedHosts.size < MAX_BLOCKED_HOSTS) {
          try {
            blockedHosts.add(new URL(req.url).host);
          } catch {
            // an unparseable blocked URL still counts as skipped; nothing to record for the host set
          }
        }
      }
      for (const form of page.forms) {
        if (isAllowed(form.action)) {
          if (endpoints.size < MAX_ENDPOINTS) recordForm(endpoints, form);
          // Auth-flow detection only for in-scope forms, so an out-of-scope login never reaches the
          // map that Unit 6 will replay against (H2).
          const authFlow = detectAuthFlow(page.finalUrl, form);
          if (authFlow !== null) authFlows.push(authFlow);
        } else {
          skippedOutOfScope++;
        }
      }

      if (item.depth < params.maxDepth) {
        const next: FrontierItem[] = [];
        for (const href of page.links) {
          const normalized = normalizeUrl(href);
          if (normalized === null) continue;
          if (isAllowed(normalized)) next.push({ url: normalized, depth: item.depth + 1 });
          else skippedOutOfScope++;
        }
        if (next.length > 0) await deps.frontier.enqueue(next);
      }
    }
  } catch (err) {
    // Infra failure mid-crawl (Redis down, etc.) — leave a terminal audit record so the trail has a
    // start AND an end (ADR-16), then propagate. Per-page fetch errors are handled above and don't
    // reach here.
    await deps.audit.append({
      scanId: params.scanId,
      action: 'crawl.failed',
      detail: safeDetail({
        reason: err instanceof Error ? err.name : 'unknown',
        pagesVisited,
        skippedOutOfScope,
        blockedHosts: [...blockedHosts],
      }),
    });
    throw err;
  }

  // Final scope choke point: no endpoint leaves this function unless its URL is in scope, regardless
  // of how it got into the map (H3). One filter no future code path can route around.
  const finalizedEndpoints = [...endpoints.values()]
    .filter((ep) => isAllowed(ep.url))
    .map(finalizeEndpoint);
  const result: CrawlerMapOutput = {
    endpoints: finalizedEndpoints,
    authFlows,
    stats: { pagesVisited, endpointsFound: finalizedEndpoints.length, skippedOutOfScope },
  };

  await deps.audit.append({
    scanId: params.scanId,
    action: 'crawl.completed',
    detail: safeDetail({
      pagesVisited,
      endpointsFound: endpoints.size,
      skippedOutOfScope,
      blockedHosts: [...blockedHosts],
    }),
  });

  return result;
}
