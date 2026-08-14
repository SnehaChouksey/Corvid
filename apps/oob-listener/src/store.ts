import { randomBytes } from 'node:crypto';

import { OOB_TOKEN } from '@corvid/redis';
import type { OobCallback } from '@corvid/tool-contracts';

// The token registry + callback ledger the listener depends on. The Redis-backed
// `OobCallbackStore` (@corvid/redis) conforms to this interface for real deployments; the in-memory
// impl below is a TEST DOUBLE ONLY (single process, lost on restart) — production requires Redis so
// the listener's writes and the runtime's reads share one ledger. A token is single-use and
// correlated: a callback for an unregistered token records nothing (that is the false-positive guard).

export interface OobCallbackRecord {
  readonly recorded: boolean;
  readonly scanId?: string;
}

export interface OobStore {
  /** Mint a unique token bound to a scan; the payload references `<token>.<host>`. */
  register(scanId: string): Promise<string>;
  /** Record an inbound callback; recorded only if the token was registered (returns owning scan). */
  markCalledBack(token: string, callback: OobCallback): Promise<OobCallbackRecord>;
  /** The correlated callback recorded for this token, or null if none. */
  getCallback(token: string): Promise<OobCallback | null>;
}

/** In-memory test double; state is lost on restart. Not for production (see the note above). */
export class InMemoryOobStore implements OobStore {
  readonly #tokens = new Map<string, string>();
  readonly #callbacks = new Map<string, OobCallback>();

  async register(scanId: string): Promise<string> {
    const token = randomBytes(16).toString('hex');
    this.#tokens.set(token, scanId);
    return Promise.resolve(token);
  }

  async markCalledBack(token: string, callback: OobCallback): Promise<OobCallbackRecord> {
    if (!OOB_TOKEN.test(token)) return Promise.resolve({ recorded: false });
    const scanId = this.#tokens.get(token);
    if (scanId === undefined) return Promise.resolve({ recorded: false });
    const recorded = !this.#callbacks.has(token);
    if (recorded) this.#callbacks.set(token, callback); // first callback wins (single-use)
    return Promise.resolve({ recorded, scanId });
  }

  async getCallback(token: string): Promise<OobCallback | null> {
    if (!OOB_TOKEN.test(token)) return Promise.resolve(null);
    return Promise.resolve(this.#callbacks.get(token) ?? null);
  }
}
