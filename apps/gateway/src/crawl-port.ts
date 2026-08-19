import { fileURLToPath } from 'node:url';

import { InfraError } from '@corvid/errors';
import type { CorvidLogger } from '@corvid/logger';
import type { ScanGraphDeps } from '@corvid/scan-runtime';
import { type CrawlerMapOutput, crawlerMapOutputSchema } from '@corvid/tool-contracts';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

// The `crawl` graph port (Unit 8 Phase 2, slab 2). The crawler is a Playwright/Chromium MCP tool
// server (apps/crawler, ADR-11); we invoke it as a SUBPROCESS over MCP stdio rather than importing
// its engine, so Chromium never loads inside the gateway process. Scope + seed + authorization are
// read server-side from the scan's target row (the tool only accepts a scanId), so this port cannot
// widen scope. Output is re-validated against the shared contract at this boundary (§1).

export interface CrawlPortDeps {
  /** Absolute path to the built crawler MCP server entry (resolved from @corvid/crawler/server). */
  readonly entryPath: string;
  /** Env passed to the spawned crawler; only the vars its loadEnv needs (DATABASE_URL/REDIS_URL/…). */
  readonly env: Record<string, string>;
  readonly logger: CorvidLogger;
}

/** Extract a compact, non-sensitive reason string from a tool-error result's content. */
function refusalReason(content: unknown): string {
  if (Array.isArray(content)) {
    const first = content[0] as { type?: string; text?: string } | undefined;
    if (first?.type === 'text' && typeof first.text === 'string') return first.text;
  }
  return 'unknown';
}

/**
 * Build the `crawl` port. Each call spawns a fresh crawler subprocess, runs one `crawler.map`, and
 * tears it down. Spawning per crawl relaunches Chromium each time (a cost), but keeps the gateway
 * stateless and needs no long-lived browser/crash-recovery in-process — acceptable for v1's
 * sequential, low-volume scans (ADR-25). A warm long-lived crawler is a later optimization.
 */
export function createCrawlPort(deps: CrawlPortDeps): ScanGraphDeps['crawl'] {
  return async (scanId: string): Promise<CrawlerMapOutput> => {
    const client = new Client({ name: 'corvid-gateway', version: '0.0.0' });
    // stderr 'inherit' so the crawler's structured logs (it logs to fd 2) reach our stderr; stdout is
    // the JSON-RPC channel and must stay clean.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [deps.entryPath],
      env: deps.env,
      stderr: 'inherit',
    });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: 'crawler.map', arguments: { scanId } });
      // A tool-level refusal (scope/authorization) is reported via isError, not thrown (§4). Surface it
      // as a fail-loud InfraError so the scan stops audibly rather than proceeding on an empty surface.
      if (result.isError === true) {
        throw new InfraError(`crawler.map refused: ${refusalReason(result.content)}`, { retryable: false });
      }
      // Re-validate the crawler's output at this boundary before it enters the graph state (§1).
      return crawlerMapOutputSchema.parse(result.structuredContent);
    } finally {
      // Always reap the subprocess (SIGTERM→SIGKILL); a close failure must not mask a crawl error.
      await client.close().catch((err: unknown) => {
        deps.logger.warn({ err }, 'crawler subprocess close failed (already exited?)');
      });
    }
  };
}

/** Resolve the built crawler MCP server entry path (@corvid/crawler/server → a filesystem path). */
export function resolveCrawlerEntry(): string {
  return fileURLToPath(import.meta.resolve('@corvid/crawler/server'));
}
