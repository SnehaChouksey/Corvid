import type { HttpSender } from '@corvid/http-send';
import type { HttpMethod } from '@corvid/tool-contracts';

// A tester sends ONLY through http.send (the choke point) — it receives that function as a port, so
// it can never open its own socket. Every tester is pure orchestration + payload construction,
// unit-testable with a fake send. A tester emits an OBSERVATION and never decides "verified" (§8).

export type SendFn = HttpSender['send'];

/** The endpoint under test, resolved from the hypothesis row (never a tool arg). */
export interface TesterTarget {
  readonly scanId: string;
  readonly url: string;
  readonly method: HttpMethod;
}

/** When http.send did not actually send (out-of-scope oracle, or an idempotent replay), a tester
 *  cannot observe — it surfaces this instead of fabricating a signal. */
export interface NotSent {
  readonly kind: 'not_sent';
  readonly reason: 'refused_out_of_scope' | 'deduplicated';
}
