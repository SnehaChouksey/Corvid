import { InfraError } from '@corvid/errors';
import { type Browser, chromium } from 'playwright';

// HTML→PDF for the report's PDF export (ADR-26). The report HTML is self-contained (inline CSS, no
// external assets), so Chromium renders it with NO network access. One browser is launched lazily and
// reused across jobs (a launch per report would be wasteful); a fresh page per render isolates jobs.
//
// SIMPLIFIED: single shared browser, no pool. Report generation is low-volume and sequential
// (ADR-25); if throughput ever demands it, add a small page/browser pool behind this same interface.

export interface PdfRenderer {
  render(html: string): Promise<Buffer>;
  close(): Promise<void>;
}

export function createPlaywrightPdfRenderer(): PdfRenderer {
  let browser: Browser | null = null;

  async function getBrowser(): Promise<Browser> {
    if (browser === null || !browser.isConnected()) {
      browser = await chromium.launch({ headless: true });
    }
    return browser;
  }

  return {
    async render(html: string): Promise<Buffer> {
      let page;
      try {
        const b = await getBrowser();
        page = await b.newPage();
        // `load` (not networkidle): the document has no external resources, so waiting on network
        // idle would only add latency. No navigation to a URL — content is set directly.
        await page.setContent(html, { waitUntil: 'load' });
        return await page.pdf({ format: 'A4', printBackground: true, margin: { top: '0', bottom: '0' } });
      } catch (cause) {
        // A render failure is a tooling error (retryable), never a silent empty PDF (§4).
        throw new InfraError('report pdf render failed', { retryable: true, cause });
      } finally {
        await page?.close().catch(() => undefined);
      }
    },
    async close(): Promise<void> {
      await browser?.close().catch(() => undefined);
      browser = null;
    },
  };
}
