import { createDb } from '@corvid/db';
import { createLogger } from '@corvid/logger';
import { createRedis, OobCallbackStore } from '@corvid/redis';
import { serve } from '@hono/node-server';

import { createOobApp } from './app.ts';
import { DbAuditSink } from './audit.ts';
import { loadEnv } from './env.ts';
import { InMemoryOobStore, type OobStore } from './store.ts';

// Composition root: validate env (fail closed), wire dependencies, serve. Nothing here has logic
// beyond wiring — the app is testable without a listening socket via `createOobApp(...).fetch`.
async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({ level: env.LOG_LEVEL, service: 'oob-listener' });
  const { db } = createDb(env.DATABASE_URL);

  let store: OobStore;
  if (env.REDIS_URL !== undefined) {
    store = new OobCallbackStore(createRedis(env.REDIS_URL));
  } else {
    logger.warn('REDIS_URL not set — OOB token store is in-memory (single instance, lost on restart). Set REDIS_URL in prod.');
    store = new InMemoryOobStore();
  }

  const app = createOobApp({ store, audit: new DbAuditSink(db), logger, oobHost: env.OOB_HOST });
  serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    logger.info({ port: info.port, oobHost: env.OOB_HOST }, 'oob-listener listening');
  });
}

main().catch((err: unknown) => {
  // Boot failure must be loud and fail the process — never a half-started listener. Log SAFE fields
  // only (no raw error message, which could carry a connection string).
  createLogger({ level: 'error', service: 'oob-listener' }).fatal(
    { err_name: err instanceof Error ? err.name : 'unknown' },
    'oob-listener failed to start',
  );
  process.exit(1);
});
