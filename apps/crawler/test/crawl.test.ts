import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { AuthorizationError } from '@corvid/errors';
import { createLogger } from '@corvid/logger';
import type { ScopeRules } from '@corvid/scope';

import {
  type AuditSink,
  type CrawlAuditEntry,
  crawl,
  type CrawlParams,
  type Frontier,
  type FrontierItem,
  type PageFetcher,
  type PageResult,
} from '../src/crawl.ts';

// These prove the two safety-critical properties WITHOUT a browser, via a fake fetcher: the crawl
// never enqueues/visits an out-of-scope URL, out-of-scope requests are counted (the fetcher aborts
// them), and every run is audited. The real Playwright abort is proven separately (opt-in) in
// fetch.integration.test.ts.

const logger = createLogger({ level: 'silent', service: 'crawler-test' });

class FakeFrontier implements Frontier {
  readonly #seen = new Set<string>();
  readonly #queue: FrontierItem[] = [];
  async enqueue(items: readonly FrontierItem[]): Promise<number> {
    let n = 0;
    for (const item of items) {
      if (!this.#seen.has(item.url)) {
        this.#seen.add(item.url);
        this.#queue.push(item);
        n++;
      }
    }
    return n;
  }
  async dequeue(): Promise<FrontierItem | null> {
    return this.#queue.shift() ?? null;
  }
}

class FakeAudit implements AuditSink {
  readonly entries: CrawlAuditEntry[] = [];
  async append(entry: CrawlAuditEntry): Promise<void> {
    this.entries.push(entry);
  }
  actions(): string[] {
    return this.entries.map((e) => e.action);
  }
}

/** Fetcher backed by a fixed page map; unknown URLs return an empty page. */
class FakeFetcher implements PageFetcher {
  readonly visited: string[] = [];
  readonly #pages: ReadonlyMap<string, PageResult>;
  constructor(pages: ReadonlyMap<string, PageResult>) {
    this.#pages = pages;
  }
  async fetchPage(url: string): Promise<PageResult> {
    this.visited.push(url);
    return (
      this.#pages.get(url) ?? {
        finalUrl: url,
        links: [],
        forms: [],
        sentRequests: [],
        blockedRequests: [],
      }
    );
  }
}

const scope: ScopeRules = { hosts: ['app.example.com'] };

function params(overrides: Partial<CrawlParams> = {}): CrawlParams {
  return {
    scanId: '00000000-0000-0000-0000-000000000001',
    targetUrl: 'https://app.example.com/',
    maxPages: 200,
    maxDepth: 10,
    ...overrides,
  };
}

test('refuses and audits a seed URL outside scope; never touches the fetcher', async () => {
  const fetcher = new FakeFetcher(new Map());
  const audit = new FakeAudit();
  await assert.rejects(
    crawl(params({ targetUrl: 'https://evil.test/' }), scope, {
      fetcher,
      frontier: new FakeFrontier(),
      audit,
      logger,
    }),
    AuthorizationError,
  );
  assert.deepEqual(fetcher.visited, []);
  assert.deepEqual(audit.actions(), ['crawl.refused']);
});

test('never enqueues or visits an out-of-scope link', async () => {
  const pages = new Map<string, PageResult>([
    [
      'https://app.example.com/',
      {
        finalUrl: 'https://app.example.com/',
        links: [
          'https://app.example.com/dashboard', // in scope → visited
          'https://evil.test/steal', // out of scope → never visited
          'mailto:admin@app.example.com', // non-http → skipped
        ],
        forms: [],
        sentRequests: [],
        blockedRequests: [],
      },
    ],
    [
      'https://app.example.com/dashboard',
      {
        finalUrl: 'https://app.example.com/dashboard',
        links: [],
        forms: [],
        sentRequests: [],
        blockedRequests: [],
      },
    ],
  ]);
  const fetcher = new FakeFetcher(pages);
  const result = await crawl(params(), scope, {
    fetcher,
    frontier: new FakeFrontier(),
    audit: new FakeAudit(),
    logger,
  });
  assert.deepEqual(fetcher.visited, [
    'https://app.example.com/',
    'https://app.example.com/dashboard',
  ]);
  assert.ok(!fetcher.visited.some((u) => u.includes('evil.test')));
  assert.equal(result.stats.pagesVisited, 2);
  assert.equal(result.stats.skippedOutOfScope, 1); // the evil.test link (mailto is not "out of scope", it's non-http)
});

test('counts blocked out-of-scope requests the page attempted (fetcher aborted them)', async () => {
  const pages = new Map<string, PageResult>([
    [
      'https://app.example.com/',
      {
        finalUrl: 'https://app.example.com/',
        links: [],
        forms: [],
        sentRequests: [
          { url: 'https://app.example.com/api/me', method: 'GET', resourceType: 'xhr' },
        ],
        blockedRequests: [
          { url: 'https://tracker.test/pixel', method: 'GET', resourceType: 'image' },
          { url: 'https://cdn.evil.test/x.js', method: 'GET', resourceType: 'script' },
        ],
      },
    ],
  ]);
  const audit = new FakeAudit();
  const result = await crawl(params(), scope, {
    fetcher: new FakeFetcher(pages),
    frontier: new FakeFrontier(),
    audit,
    logger,
  });
  assert.equal(result.stats.skippedOutOfScope, 2);
  // The visited page (navigation) + the in-scope xhr are endpoints; blocked cross-origin assets
  // are not.
  const apiEp = result.endpoints.find((e) => e.url === 'https://app.example.com/api/me');
  assert.equal(apiEp?.source, 'xhr');
  assert.ok(!result.endpoints.some((e) => e.url.includes('tracker.test')));
  assert.ok(!result.endpoints.some((e) => e.url.includes('evil.test')));
  // Completion audit records the blocked hosts so a reviewer can verify none were actually sent.
  const completed = audit.entries.find((e) => e.action === 'crawl.completed');
  assert.ok(completed?.detail?.includes('tracker.test'));
  assert.ok(completed?.detail?.includes('cdn.evil.test'));
});

test('aggregates query params onto one endpoint and detects a form login', async () => {
  const pages = new Map<string, PageResult>([
    [
      'https://app.example.com/',
      {
        finalUrl: 'https://app.example.com/',
        links: ['https://app.example.com/users?id=1', 'https://app.example.com/users?id=2'],
        forms: [
          {
            action: 'https://app.example.com/session',
            method: 'post',
            fields: [
              { name: 'email', type: 'email' },
              { name: 'password', type: 'password' },
            ],
          },
        ],
        sentRequests: [],
        blockedRequests: [],
      },
    ],
  ]);
  // The two /users pages return empty; register them so the fetcher has something to serve.
  pages.set('https://app.example.com/users?id=1', {
    finalUrl: 'https://app.example.com/users?id=1',
    links: [],
    forms: [],
    sentRequests: [],
    blockedRequests: [],
  });
  pages.set('https://app.example.com/users?id=2', {
    finalUrl: 'https://app.example.com/users?id=2',
    links: [],
    forms: [],
    sentRequests: [],
    blockedRequests: [],
  });

  const result = await crawl(params(), scope, {
    fetcher: new FakeFetcher(pages),
    frontier: new FakeFrontier(),
    audit: new FakeAudit(),
    logger,
  });

  const usersEp = result.endpoints.find((e) => e.url === 'https://app.example.com/users');
  assert.ok(usersEp, 'the two ?id= URLs collapse to one /users endpoint');
  assert.deepEqual(
    usersEp.params.map((p) => p.name),
    ['id'],
  );
  const sessionEp = result.endpoints.find((e) => e.url === 'https://app.example.com/session');
  assert.equal(sessionEp?.method, 'POST');
  assert.equal(sessionEp?.params.find((p) => p.name === 'password')?.location, 'body');

  assert.equal(result.authFlows.length, 1);
  assert.equal(result.authFlows[0]?.kind, 'form_login');
  assert.equal(result.authFlows[0]?.formAction, 'https://app.example.com/session');
});

test('empty-surface target completes cleanly with a completion audit (01 §5)', async () => {
  const audit = new FakeAudit();
  const result = await crawl(params(), scope, {
    fetcher: new FakeFetcher(new Map()),
    frontier: new FakeFrontier(),
    audit,
    logger,
  });
  assert.equal(result.stats.pagesVisited, 1);
  // Only the root page itself — no links, forms, or APIs: an effectively empty attack surface.
  assert.equal(result.endpoints.length, 1);
  assert.equal(result.endpoints[0]?.url, 'https://app.example.com/');
  assert.equal(result.authFlows.length, 0);
  assert.deepEqual(audit.actions(), ['crawl.started', 'crawl.completed']);
  const completed = audit.entries.find((e) => e.action === 'crawl.completed');
  assert.ok(completed?.detail?.includes('"stopReason":"drained"'));
});

test('respects maxPages and maxDepth bounds', async () => {
  // A chain / -> /a -> /b -> /c ; maxDepth 1 stops enqueueing past depth 1.
  const link = (from: string, to: string): PageResult => ({
    finalUrl: from,
    links: [to],
    forms: [],
    sentRequests: [],
    blockedRequests: [],
  });
  const pages = new Map<string, PageResult>([
    ['https://app.example.com/', link('https://app.example.com/', 'https://app.example.com/a')],
    ['https://app.example.com/a', link('https://app.example.com/a', 'https://app.example.com/b')],
    ['https://app.example.com/b', link('https://app.example.com/b', 'https://app.example.com/c')],
  ]);
  const fetcher = new FakeFetcher(pages);
  const result = await crawl(params({ maxDepth: 1 }), scope, {
    fetcher,
    frontier: new FakeFrontier(),
    audit: new FakeAudit(),
    logger,
  });
  // depth 0: /, depth 1: /a ; /b would be depth 2 > maxDepth so never enqueued.
  assert.deepEqual(fetcher.visited, ['https://app.example.com/', 'https://app.example.com/a']);
  assert.equal(result.stats.pagesVisited, 2);
});

/** A page that links to a fresh URL each visit, so the frontier never drains within a test window. */
class ChainFetcher implements PageFetcher {
  visited = 0;
  readonly #onFetch: () => void;
  constructor(onFetch: () => void = () => {}) {
    this.#onFetch = onFetch;
  }
  async fetchPage(url: string): Promise<PageResult> {
    this.visited++;
    this.#onFetch();
    return {
      finalUrl: url,
      links: [`https://app.example.com/p${this.visited}`],
      forms: [],
      sentRequests: [],
      blockedRequests: [],
    };
  }
}

test('stops at the wall-clock deadline with budget and frontier left (M8)', async () => {
  // Injected clock advances 100ms per fetch; deadline is 250ms → the 4th check (now=300) breaks.
  let clock = 0;
  const fetcher = new ChainFetcher(() => {
    clock += 100;
  });
  const audit = new FakeAudit();
  const result = await crawl(params({ maxPages: 1000, maxDepth: 1000, maxDurationMs: 250 }), scope, {
    fetcher,
    frontier: new FakeFrontier(),
    audit,
    logger,
    now: () => clock,
  });
  assert.equal(fetcher.visited, 3);
  assert.equal(result.stats.pagesVisited, 3);
  const completed = audit.entries.find((e) => e.action === 'crawl.completed');
  assert.ok(completed?.detail?.includes('"stopReason":"deadline"'));
});

test('records stopReason max_pages when the page budget is spent (M8)', async () => {
  const fetcher = new ChainFetcher();
  const audit = new FakeAudit();
  const result = await crawl(params({ maxPages: 2, maxDepth: 1000 }), scope, {
    fetcher,
    frontier: new FakeFrontier(),
    audit,
    logger,
  });
  assert.equal(result.stats.pagesVisited, 2);
  const completed = audit.entries.find((e) => e.action === 'crawl.completed');
  assert.ok(completed?.detail?.includes('"stopReason":"max_pages"'));
});
