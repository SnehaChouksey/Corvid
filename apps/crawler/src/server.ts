import { createDb } from '@corvid/db';
import { createLogger } from '@corvid/logger';
import { createRedis } from '@corvid/redis';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { loadEnv } from './env.ts';
import { PlaywrightFetcher } from './fetch.ts';
import { createCrawlerServer } from './tool.ts';

// Composition root for the crawler MCP server (stdio transport). One browser, one Redis client, one
// DB handle are created here and shared across tool calls.
//
// CRITICAL: on a stdio MCP server, stdout carries the JSON-RPC protocol — a stray log line there
// corrupts it. So the logger is pointed at STDERR (fd 2). Product code never uses console.* anyway
// (lint), and @corvid/logger's structured output goes to the destination we pass here.
async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({ level: env.LOG_LEVEL, service: 'crawler', destination: process.stderr });
  const { db } = createDb(env.DATABASE_URL);
  const redis = createRedis(env.REDIS_URL, logger);
  const fetcher = await PlaywrightFetcher.launch();

  serveStdio(() => createCrawlerServer({ fetcher, redis, db, logger }));
  logger.info('crawler MCP server listening on stdio');
}

main().catch((err: unknown) => {
  // Boot failure must be loud and fail the process — never a half-started server. Log SAFE fields
  // only (no raw error message, which could carry a connection string).
  createLogger({ level: 'error', service: 'crawler', destination: process.stderr }).fatal(
    { err_name: err instanceof Error ? err.name : 'unknown' },
    'crawler failed to start',
  );
  process.exit(1);
});
