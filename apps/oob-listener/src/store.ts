import { randomBytes } from 'node:crypto';

// The token registry + callback ledger the listener depends on. The Redis-backed
// `OobCallbackStore` (@corvid/redis) conforms to this interface for real deployments; the in-memory
// impl below is for tests and a single-instance box. A token is single-use and correlated: a
// callback for an unregistered token records nothing (that is the false-positive guard).

export interface OobCallbackRecord {
  readonly recorded: boolean;
  readonly scanId?: string;
}

export interface OobStore {
  /** Mint a unique token bound to a scan; the payload references `<token>.<host>`. */
  register(scanId: string): Promise<string>;
  /** Record an inbound callback; recorded only if the token was registered (returns owning scan). */
  markCalledBack(token: string): Promise<OobCallbackRecord>;
  /** Whether a correlated callback was recorded for this token. */
  wasCalledBack(token: string): Promise<boolean>;
}

/** In-memory store for tests and single-instance runs; state is lost on restart. */
export class InMemoryOobStore implements OobStore {
  readonly #tokens = new Map<string, string>();
  readonly #calledBack = new Set<string>();

  async register(scanId: string): Promise<string> {
    const token = randomBytes(16).toString('hex');
    this.#tokens.set(token, scanId);
    return Promise.resolve(token);
  }

  async markCalledBack(token: string): Promise<OobCallbackRecord> {
    const scanId = this.#tokens.get(token);
    if (scanId === undefined) return Promise.resolve({ recorded: false });
    const recorded = !this.#calledBack.has(token);
    this.#calledBack.add(token);
    return Promise.resolve({ recorded, scanId });
  }

  async wasCalledBack(token: string): Promise<boolean> {
    return Promise.resolve(this.#calledBack.has(token));
  }
}
