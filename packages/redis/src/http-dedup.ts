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

  /** Whether a request key was already sent this scan. Checked BEFORE sending. Fail-closed. */
  async has(requestKey: string): Promise<boolean> {
    try {
      return (await this.#redis.sismember(this.key, requestKey)) === 1;
    } catch (cause) {
      // Fail closed: if we can't tell whether it was sent, don't send (uncertainty ≠ a green light).
      throw new InfraError('http-dedup has failed', { retryable: true, cause });
    }
  }

  /** Mark a request key sent. Called AFTER a completed send, so a send that threw is re-tried on
   *  replay (never silently dropped). Returns true if it was newly added. */
  async markSent(requestKey: string): Promise<boolean> {
    try {
      const added = await this.#redis.sadd(this.key, requestKey);
      await this.#redis.expire(this.key, this.#ttlSeconds);
      return added === 1;
    } catch (cause) {
      throw new InfraError('http-dedup markSent failed', { retryable: true, cause });
    }
  }

  /** Drop this scan's sent-request set. */
  async clear(): Promise<void> {
    await this.#redis.del(this.key);
  }
}
