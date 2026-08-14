import { randomBytes } from 'node:crypto';

import { InfraError } from '@corvid/errors';
import type { Redis } from 'ioredis';

const NAMESPACE = 'corvid:oob';

/** A registered token that recorded a callback carries the scan it belonged to (for the audit note). */
export interface OobCallbackRecord {
  readonly recorded: boolean;
  readonly scanId?: string;
}

/**
 * Redis-backed OOB token registry + callback ledger for the self-hosted listener (ADR-09, D-16).
 *
 * A token is single-use and correlated: `register` mints a unique token bound to one scan; a later
 * inbound callback to `<token>.<host>` is recorded ONLY if that token was registered (an arbitrary
 * subdomain probe records nothing — correlation is the guard against a false positive). The verifier
 * reads `wasCalledBack`. Redis (not in-process memory) so a register in one service and the query in
 * another see the same ledger, and a listener restart mid-wait doesn't lose a pending token.
 *
 * Fail closed: a Redis error is never read as "no callback". `wasCalledBack` throws an InfraError so
 * the verify gate treats it as a tooling error (§4), never a clean negative that could hide a real
 * callback — the one thing that must not happen is fabricating a not_confirmed from an outage.
 */
export class OobCallbackStore {
  readonly #redis: Redis;
  readonly #ttlSeconds: number;

  constructor(redis: Redis, ttlSeconds = 86_400) {
    this.#redis = redis;
    this.#ttlSeconds = ttlSeconds;
  }

  #tokenKey(token: string): string {
    return `${NAMESPACE}:token:${token}`;
  }

  #callbackKey(token: string): string {
    return `${NAMESPACE}:cb:${token}`;
  }

  /** Mint a unique single-use token bound to a scan; the payload references `<token>.<host>`. */
  async register(scanId: string): Promise<string> {
    const token = randomBytes(16).toString('hex'); // 32 hex chars — a safe, unique DNS label
    try {
      await this.#redis.set(this.#tokenKey(token), scanId, 'EX', this.#ttlSeconds);
      return token;
    } catch (cause) {
      throw new InfraError('oob-store register failed', { retryable: true, cause });
    }
  }

  /**
   * Record an inbound callback for a token. Recorded ONLY if the token was registered (correlation):
   * an unregistered token returns `{ recorded: false }` and is ignored. Returns the owning scan id so
   * the listener can attribute the callback in the audit trail (ADR-16).
   */
  async markCalledBack(token: string): Promise<OobCallbackRecord> {
    try {
      const scanId = await this.#redis.get(this.#tokenKey(token));
      if (scanId === null) return { recorded: false };
      const added = await this.#redis.set(this.#callbackKey(token), '1', 'EX', this.#ttlSeconds, 'NX');
      return { recorded: added === 'OK', scanId };
    } catch (cause) {
      throw new InfraError('oob-store markCalledBack failed', { retryable: true, cause });
    }
  }

  /** Whether a correlated callback was recorded for this token. Fail-closed (throws, never false). */
  async wasCalledBack(token: string): Promise<boolean> {
    try {
      return (await this.#redis.exists(this.#callbackKey(token))) === 1;
    } catch (cause) {
      // Never let an outage masquerade as "no callback": that is the exact fabricated clean-negative
      // §4 forbids. Surface an error so the verify gate records a tooling error, not a not_confirmed.
      throw new InfraError('oob-store wasCalledBack failed', { retryable: true, cause });
    }
  }
}
