import { InfraError } from '@corvid/errors';
import type { Redis } from 'ioredis';

const NAMESPACE = 'corvid:httpdedup';

/**
 * Per-scan sent-request dedup for `http.send` (ADR-27 idempotency): a request already sent in this
 * scan is never re-sent, so a replayed LangGraph node's identical payload is safe. Fail closed — if
 * Redis is unreachable we CANNOT confirm a request is new, and the dangerous action is *sending*, so
 * we surface an error (the caller does not send) rather than risk a double-send.
 */
export class HttpRequestDedup {
  readonly #redis: Redis;
  readonly #ttlSeconds: number;
  private readonly key: string;

  constructor(redis: Redis, scanId: string, ttlSeconds = 86_400) {
    this.#redis = redis;
    this.#ttlSeconds = ttlSeconds;
    this.key = `${NAMESPACE}:${scanId}:sent`;
  }

  /** Mark a request key sent. Returns true if it was NEW (send it), false if already sent (skip). */
  async markNew(requestKey: string): Promise<boolean> {
    try {
      const added = await this.#redis.sadd(this.key, requestKey);
      await this.#redis.expire(this.key, this.#ttlSeconds);
      return added === 1;
    } catch (cause) {
      // Fail closed: uncertainty about "already sent?" must not lead to a send.
      throw new InfraError('http-dedup markNew failed', { retryable: true, cause });
    }
  }

  /** Drop this scan's sent-request set. */
  async clear(): Promise<void> {
    await this.#redis.del(this.key);
  }
}
