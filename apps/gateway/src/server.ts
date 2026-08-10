import { createAuth } from '@corvid/auth';
import { createDb } from '@corvid/db';
import { createLogger } from '@corvid/logger';
import { serve } from '@hono/node-server';

import { createApp } from './app.ts';
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
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port }, 'gateway listening');
});
