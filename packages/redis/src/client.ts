import type { CorvidLogger } from '@corvid/logger';
import { Redis } from 'ioredis';

export type RedisClient = Redis;

/**
 * ioredis client factory with fixed, safe defaults.
 * - `maxRetriesPerRequest: null` keeps blocking commands and durable consumers (BullMQ fan-out
 *   lands in Unit 7, ADR-17) working; harmless for the plain frontier/dedup commands used here.
 * - `lazyConnect` defers the TCP connect to the first command, so constructing a client never
 *   throws — an unreachable Redis fails loud at use, not at import.
 *
 * An inline options literal (rather than a passed-through `RedisOptions` value) is deliberate:
 * ioredis's own option types don't compose with our `exactOptionalPropertyTypes`. A caller that
 * genuinely needs another option should add it here explicitly, not thread an arbitrary bag
 * through (and reopen that type hole).
 *
 * An `error` listener is always attached: an ioredis client is an EventEmitter, and an 'error'
 * event with no listener prints a raw `[ioredis] Unhandled error event` stack straight to the
 * console, bypassing the structured logger (§13). Connection-level errors — e.g. an idle TLS reset
 * from a managed Redis (Upstash) — are transient and ioredis auto-reconnects, so they are surfaced
 * at `warn` and recovery is left to ioredis rather than treated as fatal. `logger` is optional so
 * opt-in integration tests need not thread one through; without it the handler stays silent by
 * design (its sole job there is to keep the raw-console path from ever being taken).
 */
export function createRedis(url: string, logger?: CorvidLogger): Redis {
  const redis = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: true });
  redis.on('error', (err: unknown) => {
    logger?.warn({ err }, 'redis client error (ioredis will attempt to reconnect)');
  });
  return redis;
}
