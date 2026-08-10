import { type Database, getTargetForScan } from '@corvid/db';
import { AuthorizationError } from '@corvid/errors';
import { type CorvidLogger, withFields } from '@corvid/logger';
import { CrawlFrontier, type RedisClient } from '@corvid/redis';
import { parseScopeRules } from '@corvid/scope';
import { crawlerMapInputSchema, crawlerMapOutputSchema } from '@corvid/tool-contracts';
import { type CallToolResult, McpServer } from '@modelcontextprotocol/server';

import { DbAuditSink } from './audit.ts';
import { crawl, type PageFetcher } from './crawl.ts';

/** A refusal is a typed tool outcome (`isError`), not a thrown protocol exception (§4). */
function refusal(reason: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: `crawl_refused:${reason}` }] };
}

export interface CrawlerDeps {
  readonly fetcher: PageFetcher;
  readonly redis: RedisClient;
  readonly db: Database;
  readonly logger: CorvidLogger;
  /** How long a scan's frontier/dedup keys live in Redis before self-cleaning. */
  readonly frontierTtlSeconds?: number;
}

/**
 * Register the `crawler.map` MCP tool (`02` §10). The tool VALIDATES input against the shared
 * contract (Zod v4), runs the passive crawl, and returns the endpoint/param/auth-flow map. It emits
 * observations only — it never decides "verified" and never sends a payload. Heavyweight deps (the
 * Playwright browser, Redis, DB) are created once at server start and reused across calls.
 */
export function registerCrawlerTool(server: McpServer, deps: CrawlerDeps): void {
  server.registerTool(
    'crawler.map',
    {
      title: 'Map attack surface',
      description:
        'Passively crawl an authorized target within its recorded scope and return the endpoint ' +
        'list, parameters, and detected auth-flow map. Renders SPAs. Sends no payloads; aborts any ' +
        'out-of-scope request before it leaves the browser.',
      inputSchema: crawlerMapInputSchema,
      outputSchema: crawlerMapOutputSchema,
    },
    async (args) => {
      const audit = new DbAuditSink(deps.db);

      // The recorded-authorization gate: seed URL + scope + authorization all come from the scan's
      // target in the DB, never from a tool argument. A caller can only choose WHICH scan to crawl.
      const target = await getTargetForScan(deps.db, args.scanId);
      if (target === undefined) {
        return refusal('scan_not_found');
      }
      const confirmedAt = target.authorizationConfirmedAt;
      if (!(confirmedAt instanceof Date) || Number.isNaN(confirmedAt.getTime())) {
        await audit.append({
          scanId: args.scanId,
          action: 'crawl.refused',
          detail: JSON.stringify({ reason: 'authorization_not_confirmed' }),
        });
        return refusal('authorization_not_confirmed');
      }

      // parseScopeRules is the authoritative validator (dangerous-host reject, fail closed).
      const scope = parseScopeRules(target.scopeRules);
      const frontier = new CrawlFrontier(deps.redis, args.scanId, deps.frontierTtlSeconds);

      try {
        const output = await crawl(
          {
            scanId: args.scanId,
            targetUrl: target.url,
            maxPages: args.maxPages,
            maxDepth: args.maxDepth,
          },
          scope,
          {
            fetcher: deps.fetcher,
            frontier,
            audit,
            logger: withFields(deps.logger, { scan_id: args.scanId }),
          },
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(output) }],
          structuredContent: output,
        };
      } catch (err) {
        // A scope/authorization refusal is a typed DOMAIN OUTCOME, not a protocol crash (§4).
        if (err instanceof AuthorizationError) return refusal('seed_out_of_scope');
        throw err;
      }
    },
  );
}

/** Build a fully-registered crawler MCP server. */
export function createCrawlerServer(deps: CrawlerDeps): McpServer {
  const server = new McpServer(
    { name: 'corvid-crawler', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );
  registerCrawlerTool(server, deps);
  return server;
}
