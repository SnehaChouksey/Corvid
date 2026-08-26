import { type Browser, type BrowserContext, chromium } from 'playwright';

import type { ObservedForm, ObservedRequest, PageFetcher, PageResult } from './crawl.ts';

// The real Playwright-backed PageFetcher. The safety-critical behavior lives in the request
// interceptor: every request is checked against `isAllowed` and an out-of-scope one is ABORTED
// before it leaves the browser, so the passive crawl cannot issue an out-of-scope request while it
// runs outside the E2B sandbox in v1 (the sandbox is the active-testing burst, ADR-22; the
// crawler-outside-sandbox risk acceptance is ADR-D17 / D-17).
//
// Enforcement is at the CONTEXT, not the page: `context.route` covers requests from popups and
// child pages that a page-level route misses. Service workers are blocked (their fetches bypass
// page routing) and all WebSocket connections are closed (a passive crawl needs none, and an
// out-of-scope `wss://` would otherwise escape). A fresh context per crawl isolates cookies/cache
// between scans (and, later, tenants).

export interface PlaywrightFetcherOptions {
  /** Hard cap on a single page's navigation (ms). Keeps one slow page from stalling the crawl. */
  readonly navigationTimeoutMs?: number;
  /** How long to wait for the network to settle after DOMContentLoaded, to capture SPA XHRs (ms). */
  readonly networkIdleTimeoutMs?: number;
  /**
   * Extra Chromium launch args. Empty in production. Used by the integration test to remap fake
   * hostnames to a loopback fixture (`--host-resolver-rules`), since the scope validator correctly
   * refuses loopback/localhost hosts, so a fixture can't be scoped as `127.0.0.1` directly.
   */
  readonly browserArgs?: readonly string[];
}

const DEFAULT_NAV_TIMEOUT_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT_MS = 3_000;
/** Cap links extracted from one page so a hostile page can't blow heap (M6). */
const MAX_LINKS_PER_PAGE = 1000;

export class PlaywrightFetcher implements PageFetcher {
  readonly #browser: Browser;
  readonly #navigationTimeoutMs: number;
  readonly #networkIdleTimeoutMs: number;

  private constructor(browser: Browser, options: PlaywrightFetcherOptions) {
    this.#browser = browser;
    this.#navigationTimeoutMs = options.navigationTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS;
    this.#networkIdleTimeoutMs = options.networkIdleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  static async launch(options: PlaywrightFetcherOptions = {}): Promise<PlaywrightFetcher> {
    const browser: Browser = await chromium.launch({
      headless: true,
      args: [...(options.browserArgs ?? [])],
    });
    return new PlaywrightFetcher(browser, options);
  }

  async close(): Promise<void> {
    await this.#browser.close();
  }

  async fetchPage(url: string, isAllowed: (u: string) => boolean): Promise<PageResult> {
    // A fresh context per fetch: isolation between crawls, and the one place scope is enforced for
    // every page (including popups) in this context. Service workers blocked so their fetches can't
    // bypass routing.
    const context: BrowserContext = await this.#browser.newContext({ serviceWorkers: 'block' });
    const sentRequests: ObservedRequest[] = [];
    const blockedRequests: ObservedRequest[] = [];

    try {
      await context.route('**/*', async (route) => {
        try {
          const request = route.request();
          // Capture the POST/PUT/PATCH body so the engine can derive body params (JSON/form) — the
          // real attack surface of a fetch/XHR API. postData() is null for bodyless requests.
          const postData = request.postData() ?? undefined;
          const observed: ObservedRequest = {
            url: request.url(),
            method: request.method(),
            resourceType: request.resourceType(),
            ...(postData !== undefined ? { body: postData } : {}),
          };
          if (isAllowed(observed.url)) {
            sentRequests.push(observed);
            await route.continue();
          } else {
            // Out of scope — abort BEFORE it leaves the browser. This is the enforcement point.
            blockedRequests.push(observed);
            await route.abort();
          }
        } catch {
          // A route can throw if the page/route was already torn down mid-handle. Fail CLOSED:
          // abort rather than continue, and ignore a secondary error on the abort itself.
          await route.abort().catch(() => undefined);
        }
      });

      // A passive crawl opens no WebSockets; close any the page attempts so an out-of-scope wss://
      // can't escape (page routing never sees WebSockets).
      await context.routeWebSocket('**/*', (ws) => ws.close());

      const page = await context.newPage();
      // Don't render popups we never read — close them (their out-of-scope requests are already
      // aborted by the context route above; this just bounds work).
      page.on('popup', (popup) => void popup.close().catch(() => undefined));

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.#navigationTimeoutMs });

      // Give SPA XHRs a bounded window to fire. Networkidle timing out is EXPECTED for a page that
      // never goes quiet (polling/websockets) and is not actionable — we proceed with what rendered.
      await page
        .waitForLoadState('networkidle', { timeout: this.#networkIdleTimeoutMs })
        .catch(() => undefined);

      const finalUrl = page.url();
      const extracted = await page.evaluate((maxLinks: number) => {
        const links = Array.from(document.querySelectorAll('a[href]'))
          .map((a) => (a as HTMLAnchorElement).href)
          .filter((href) => href.length > 0)
          .slice(0, maxLinks);
        const forms = Array.from(document.querySelectorAll('form')).map((form) => {
          const fields = Array.from(form.querySelectorAll('input, select, textarea')).map((el) => {
            const field = el as HTMLInputElement;
            return {
              name: field.name,
              type: field.type.length > 0 ? field.type : el.tagName.toLowerCase(),
            };
          });
          return {
            action: form.action,
            method: form.method.length > 0 ? form.method : 'get',
            fields,
          };
        });
        return { links, forms };
      }, MAX_LINKS_PER_PAGE);

      const forms: ObservedForm[] = extracted.forms.map((f) => ({
        action: f.action,
        method: f.method,
        fields: f.fields,
      }));

      return { finalUrl, links: extracted.links, forms, sentRequests, blockedRequests };
    } finally {
      await context.close();
    }
  }
}
