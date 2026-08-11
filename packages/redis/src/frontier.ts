import { InfraError } from '@corvid/errors';
import type { Redis } from 'ioredis';

export interface FrontierItem {
  readonly url: string;
  readonly depth: number;
}

const NAMESPACE = 'corvid:crawl';

/** A pipeline result tuple as ioredis returns it: `[error, value]` per queued command. */
type PipelineResult = [Error | null, unknown];

/**
 * Fail closed on a Redis pipeline failure (M5): a `null` result (batch aborted) or an error in any
 * tuple leaves the frontier's post-condition unknown, so surface an InfraError rather than let a
 * caller read "no result" as "nothing to do" — a silent empty enqueue of the seed would otherwise
 * make a crawl "complete" against an empty surface. Retryable; the crawl loop audits before rethrow.
 */
function assertPipelineOk(results: PipelineResult[] | null, op: string): PipelineResult[] {
  if (results === null) {
    throw new InfraError(`Redis frontier ${op} pipeline returned no result`, { retryable: true });
  }
  for (const [err] of results) {
    if (err !== null) {
      throw new InfraError(`Redis frontier ${op} pipeline command failed`, {
        retryable: true,
        cause: err,
      });
    }
  }
  return results;
}

/**
 * Redis-backed crawl frontier + dedup set, namespaced per scan (`02` §8).
 *
 * The dedup set is the safety-relevant half: a URL is enqueued at most once per scan, so a crawl of
 * a cyclic site terminates and can't be driven into an unbounded loop. Scope is enforced by the
 * CALLER before enqueue (the crawler checks @corvid/scope) — the frontier is scope-agnostic
 * plumbing and never decides what is in bounds. Keys carry a TTL so an abandoned crawl self-cleans.
 */
export class CrawlFrontier {
  // Fields declared explicitly (not constructor parameter properties): Node's strip-only
  // type-stripping used by `node --test` does not support parameter properties.
  readonly #redis: Redis;
  readonly #ttlSeconds: number;
  private readonly frontierKey: string;
  private readonly seenKey: string;

  constructor(redis: Redis, scanId: string, ttlSeconds = 3600) {
    this.#redis = redis;
    this.#ttlSeconds = ttlSeconds;
    this.frontierKey = `${NAMESPACE}:${scanId}:frontier`;
    this.seenKey = `${NAMESPACE}:${scanId}:seen`;
  }

  /**
   * Enqueue only URLs not seen before in this scan. Returns the count actually enqueued (the new
   * ones). Dedup (`SADD`) and enqueue (`RPUSH`) run in pipelines; the caller is responsible for
   * normalizing URLs so equivalent URLs collapse to one dedup key.
   */
  async enqueue(items: readonly FrontierItem[]): Promise<number> {
    if (items.length === 0) return 0;

    const addPipe = this.#redis.pipeline();
    for (const item of items) addPipe.sadd(this.seenKey, item.url);
    const results = assertPipelineOk(await addPipe.exec(), 'dedup');

    const pushPipe = this.#redis.pipeline();
    let enqueued = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item === undefined) continue;
      const outcome = results[i];
      const isNew = outcome !== undefined && outcome[0] === null && outcome[1] === 1;
      if (isNew) {
        pushPipe.rpush(this.frontierKey, JSON.stringify(item));
        enqueued++;
      }
    }
    if (enqueued > 0) {
      pushPipe.expire(this.frontierKey, this.#ttlSeconds);
      pushPipe.expire(this.seenKey, this.#ttlSeconds);
      // If this pipeline is lost, the URLs are marked seen (SADD above) but not queued — they'd be
      // silently dropped from the crawl. Fail closed so the crawl aborts instead of proceeding on
      // partial state (M5).
      assertPipelineOk(await pushPipe.exec(), 'enqueue');
    }
    return enqueued;
  }

  /** Pop the next URL to visit, or null when the frontier is drained. */
  async dequeue(): Promise<FrontierItem | null> {
    const raw = await this.#redis.lpop(this.frontierKey);
    if (raw === null) return null;
    // Refresh both keys' TTL on every active dequeue (M4): only enqueue reset it before, so a long
    // crawl that stopped discovering links could let the dedup/frontier state expire mid-crawl and
    // lose the termination guarantee. A Redis error here propagates and fails closed (M5).
    assertPipelineOk(
      await this.#redis
        .pipeline()
        .expire(this.frontierKey, this.#ttlSeconds)
        .expire(this.seenKey, this.#ttlSeconds)
        .exec(),
      'ttl-refresh',
    );
    return JSON.parse(raw) as FrontierItem;
  }

  /** Number of URLs still waiting to be visited. */
  async size(): Promise<number> {
    return this.#redis.llen(this.frontierKey);
  }

  /** Number of distinct URLs seen this scan (visited + queued). */
  async seenCount(): Promise<number> {
    return this.#redis.scard(this.seenKey);
  }

  /** Drop this scan's frontier + dedup state. */
  async clear(): Promise<void> {
    await this.#redis.del(this.frontierKey, this.seenKey);
  }
}
