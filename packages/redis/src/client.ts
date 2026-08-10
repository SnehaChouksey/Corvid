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
 */
export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, lazyConnect: true });
}
