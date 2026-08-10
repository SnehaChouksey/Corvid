import type { Redis } from 'ioredis';

// Adapter so hono-rate-limiter's `RedisStore` can run on our ioredis client. `RedisStore` expects a
// node-redis-shaped client (`scriptLoad`, `evalsha(sha, keys, args)`), while ioredis exposes
// `script('LOAD', ...)` and a variadic `evalsha`. This four-method shim bridges the two without
// pulling a second Redis client into the repo (ioredis is our one client, for BullMQ parity later).
// Kept here (Redis plumbing) but dependency-free of hono-rate-limiter: the shape is structural.

export interface HonoRateLimitRedisClient {
  scriptLoad(script: string): Promise<string>;
  evalsha<TArgs extends unknown[], TData = unknown>(
    sha1: string,
    keys: string[],
    args: TArgs,
  ): Promise<TData>;
  decr(key: string): Promise<number>;
  del(key: string): Promise<number>;
}

function isNoScriptError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('NOSCRIPT');
}

export function honoRateLimitClient(redis: Redis): HonoRateLimitRedisClient {
  // Remember each loaded script by its SHA so we can re-load it if Redis forgets it (restart or
  // SCRIPT FLUSH → NOSCRIPT). Without this, the limiter would throw on every request forever after
  // a Redis blip — an abuse control failing unrecoverably (M9).
  const scriptBySha = new Map<string, string>();

  return {
    scriptLoad: async (script) => {
      const sha = (await redis.script('LOAD', script)) as string;
      scriptBySha.set(sha, script);
      return sha;
    },
    evalsha: async <TArgs extends unknown[], TData = unknown>(
      sha1: string,
      keys: string[],
      args: TArgs,
    ): Promise<TData> => {
      const evalArgs = args as (string | number)[];
      try {
        return (await redis.evalsha(sha1, keys.length, ...keys, ...evalArgs)) as TData;
      } catch (err) {
        const script = scriptBySha.get(sha1);
        if (!isNoScriptError(err) || script === undefined) throw err;
        // Redis forgot the script — re-run by body (which re-caches it under the same SHA), retry once.
        return (await redis.eval(script, keys.length, ...keys, ...evalArgs)) as TData;
      }
    },
    decr: (key) => redis.decr(key),
    del: (key) => redis.del(key),
  };
}
