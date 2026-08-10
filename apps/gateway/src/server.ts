import { createAuth } from '@corvid/auth';
import { createDb } from '@corvid/db';
import { createLogger } from '@corvid/logger';
import { createRedis, honoRateLimitClient } from '@corvid/redis';
import { serve } from '@hono/node-server';
import { RedisStore, type Store } from 'hono-rate-limiter';

import { type AppEnv, createApp } from './app.ts';
import { loadEnv } from './env.ts';

// Composition root: validate env (fail closed), wire dependencies, serve. Nothing here has logic
// beyond wiring — the app is testable without a listening socket via `createApp(...).fetch`.
const env = loadEnv();
const logger = createLogger({ level: env.LOG_LEVEL, service: 'gateway' });
const { db } = createDb(env.DATABASE_URL);
const auth = createAuth({
  database: db,
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
});

// Redis-backed rate-limit store when REDIS_URL is set (shared across instances, ADR-20). Without
// it, hono-rate-limiter's in-memory store is used — correct for a single instance only.
let rateLimitStore: ((prefix: string) => Store<AppEnv>) | undefined;
if (env.REDIS_URL !== undefined) {
  const redis = createRedis(env.REDIS_URL);
  const client = honoRateLimitClient(redis);
  rateLimitStore = (prefix) => new RedisStore<AppEnv>({ client, prefix: `corvid:rl:${prefix}:` });
} else {
  logger.warn('REDIS_URL not set — rate limiting is in-memory (per-process). Set REDIS_URL in prod.');
}

const app = createApp({
  auth,
  db,
  limits: {
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
    authMax: env.AUTH_RATE_LIMIT_MAX,
    concurrentScanCap: env.CONCURRENT_SCAN_CAP,
  },
  logger,
  ...(rateLimitStore !== undefined ? { rateLimitStore } : {}),
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port }, 'gateway listening');
});
