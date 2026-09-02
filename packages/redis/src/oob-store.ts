import { randomBytes } from 'node:crypto';

import { InfraError } from '@corvid/errors';
import type { OobCallback } from '@corvid/tool-contracts';
import type { Redis } from 'ioredis';

const NAMESPACE = 'corvid:oob';

/** The fixed mint shape of an OOB token (16 random bytes, hex). The one input that can flip a
 *  verdict to `verified`, so it is validated fail-closed at every boundary that touches it. */
export const OOB_TOKEN = /^[0-9a-f]{32}$/;

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
 * reads `getCallback` and gets the callback's provenance (receivedAt + sourceIp), which the proof
 * carries. Redis (not in-process memory) so a register in one service and the query in another see
 * the same ledger, and a listener restart mid-wait doesn't lose a pending token.
 *
 * Fail closed: a Redis error is never read as "no callback". `getCallback` throws an InfraError so
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
   * Record an inbound callback for a token. Recorded ONLY if the token was registered (correlation)
   * and well-formed. Returns the owning scan id so the listener can attribute the callback in the
   * audit trail (ADR-16). The callback's provenance (receivedAt + sourceIp) is stored for the proof.
   */
  async markCalledBack(token: string, callback: OobCallback): Promise<OobCallbackRecord> {
    if (!OOB_TOKEN.test(token)) return { recorded: false };
    try {
      const scanId = await this.#redis.get(this.#tokenKey(token));
      if (scanId === null) return { recorded: false };
      // First callback wins (single-use): NX so a replayed/duplicate callback never overwrites the
      // recorded provenance and never double-counts.
      const added = await this.#redis.set(
        this.#callbackKey(token),
        JSON.stringify(callback),
        'EX',
        this.#ttlSeconds,
        'NX',
      );
      return { recorded: added === 'OK', scanId };
    } catch (cause) {
      throw new InfraError('oob-store markCalledBack failed', { retryable: true, cause });
    }
  }

  /** The correlated callback recorded for this token, or null if none. Fail-closed (throws on outage). */
  async getCallback(token: string): Promise<OobCallback | null> {
    if (!OOB_TOKEN.test(token)) return null;
    try {
      const raw = await this.#redis.get(this.#callbackKey(token));
      return raw === null ? null : (JSON.parse(raw) as OobCallback);
    } catch (cause) {
      // Never let an outage masquerade as "no callback": that is the exact fabricated clean-negative
      // §4 forbids. Surface an error so the verify gate records a tooling error, not a not_confirmed.
      throw new InfraError('oob-store getCallback failed', { retryable: true, cause });
    }
  }
}

/** One scan paused at the durable `awaitOob` interrupt, and when its wait began (epoch ms). */
export interface PausedOobThread {
  readonly threadId: string;
  readonly interruptedAt: number;
}

/**
 * Redis-backed registry of scans currently paused at the `awaitOob` interrupt (D-4). The gateway
 * records a scan here when its graph run pauses for the out-of-band callback, and the periodic OOB
 * sweep reads it to find waits past the D-4 bound and resume them (ADR-32/ADR-33). Redis (not
 * in-process) so the registry survives a gateway restart mid-wait and a later restart's sweep still
 * resolves the pause — a paused scan whose registry entry was lost would hang forever.
 *
 * This is a liveness aid, not a safety gate: the durable authority for what's paused is the LangGraph
 * checkpointer; reconstructing the registry from it (so a lost entry self-heals) is deferred hardening.
 */
export class OobPausedStore {
  readonly #redis: Redis;
  readonly #key = `${NAMESPACE}:paused`;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  /** Record a scan as paused at `awaitOob`, stamped with when the wait began. Idempotent per scan. */
  async add(threadId: string, interruptedAtMs: number): Promise<void> {
    try {
      await this.#redis.hset(this.#key, threadId, String(interruptedAtMs));
    } catch (cause) {
      throw new InfraError('oob-paused add failed', { retryable: true, cause });
    }
  }

  /** Drop a scan from the registry once its wait is resolved (resumed to a verdict). */
  async remove(threadId: string): Promise<void> {
    try {
      await this.#redis.hdel(this.#key, threadId);
    } catch (cause) {
      throw new InfraError('oob-paused remove failed', { retryable: true, cause });
    }
  }

  /** Every scan currently registered as paused, with when each began waiting. */
  async list(): Promise<readonly PausedOobThread[]> {
    try {
      const all = await this.#redis.hgetall(this.#key);
      return Object.entries(all)
        .map(([threadId, v]) => ({ threadId, interruptedAt: Number(v) }))
        .filter((t) => Number.isFinite(t.interruptedAt));
    } catch (cause) {
      throw new InfraError('oob-paused list failed', { retryable: true, cause });
    }
  }
}
