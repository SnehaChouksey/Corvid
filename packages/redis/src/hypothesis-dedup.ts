import { InfraError } from '@corvid/errors';
import type { Redis } from 'ioredis';

const NAMESPACE = 'corvid:hypo';

/** A pipeline result tuple as ioredis returns it: `[error, value]` per queued command. */
type PipelineResult = [Error | null, unknown];

/**
 * Fail closed on a Redis pipeline failure (M5, mirrors the crawl frontier): a `null` result (batch
 * aborted) or an error in any tuple leaves the dedup post-condition unknown — surface an InfraError
 * rather than let a caller read "no result" as "nothing new", which would silently drop hypotheses.
 */
function assertPipelineOk(results: PipelineResult[] | null, op: string): PipelineResult[] {
  if (results === null) {
    throw new InfraError(`Redis hypothesis-dedup ${op} pipeline returned no result`, { retryable: true });
  }
  for (const [err] of results) {
    if (err !== null) {
      throw new InfraError(`Redis hypothesis-dedup ${op} pipeline command failed`, {
        retryable: true,
        cause: err,
      });
    }
  }
  return results;
}

/**
 * Per-scan hypothesis dedup set (D-10 / ADR-D10), namespaced per scan. This is the fast per-scan
 * cache the spec calls for — it lets the agent skip re-proposing and a tester skip re-testing a
 * fingerprint. The DURABLE dedup authority is the DB unique `(scan_id, fingerprint)` with
 * `onConflictDoNothing` (ADR-27 replay-safety); this set is an optimization layered on top, so it
 * being flushed can never cause a duplicate finding. Keys carry a TTL so an abandoned scan self-cleans.
 */
export class HypothesisDedup {
  // Fields declared explicitly (not constructor parameter properties): Node's strip-only
  // type-stripping used by `node --test` does not support parameter properties.
  readonly #redis: Redis;
  readonly #ttlSeconds: number;
  private readonly seenKey: string;

  constructor(redis: Redis, scanId: string, ttlSeconds = 86_400) {
    this.#redis = redis;
    this.#ttlSeconds = ttlSeconds;
    this.seenKey = `${NAMESPACE}:${scanId}:seen`;
  }

  /**
   * Mark each fingerprint seen and return only those NOT already seen this scan. `SADD` returns 1
   * for a newly-added member, 0 for an existing one. Refreshes the key TTL so an active scan's cache
   * doesn't expire mid-run. Fail-closed on a lost/errored pipeline (M5).
   */
  async filterUnseen(fingerprints: readonly string[]): Promise<string[]> {
    if (fingerprints.length === 0) return [];
    const pipe = this.#redis.pipeline();
    for (const fp of fingerprints) pipe.sadd(this.seenKey, fp);
    pipe.expire(this.seenKey, this.#ttlSeconds);
    const results = assertPipelineOk(await pipe.exec(), 'mark');

    const fresh: string[] = [];
    for (let i = 0; i < fingerprints.length; i++) {
      const fp = fingerprints[i];
      const outcome = results[i];
      const isNew = outcome !== undefined && outcome[0] === null && outcome[1] === 1;
      if (fp !== undefined && isNew) fresh.push(fp);
    }
    return fresh;
  }

  /** Whether a fingerprint has been seen this scan. */
  async has(fingerprint: string): Promise<boolean> {
    return (await this.#redis.sismember(this.seenKey, fingerprint)) === 1;
  }

  /** Number of distinct fingerprints seen this scan. */
  async seenCount(): Promise<number> {
    return this.#redis.scard(this.seenKey);
  }

  /** Drop this scan's dedup set. */
  async clear(): Promise<void> {
    await this.#redis.del(this.seenKey);
  }
}
