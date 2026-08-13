import { createHash } from 'node:crypto';

import { AuthorizationError } from '@corvid/errors';
import { isUrlInScope } from '@corvid/scope';
import type { HttpSendInput, HttpSendOutput } from '@corvid/tool-contracts';

import { backoffAfterFailure, nextDelayMs } from './rate.ts';
import { DEFAULT_RATE_CONFIG, type FetchRequest, type HttpSender, type HttpSendPorts } from './types.ts';

// The one enforced order (Unit 4, ADR-24/25). Each guard runs BEFORE any network I/O except the
// send itself; every branch is audited (ADR-16). A tool never decides "verified" — this returns the
// raw response observation and the gate (Unit 5) decides.

// ASCII Unit Separator between fields so no field's contents can be mistaken for a boundary.
const FIELD_SEP = String.fromCharCode(0x1f);

/**
 * Stable per-scan dedup key: method + full url + canonical headers + body. Headers ARE included —
 * two requests to the same URL that differ only in auth (JWT/IDOR testing) are DIFFERENT tests and
 * must not collapse; an identical replay (same headers) still collapses (idempotent, ADR-27). The
 * whole key is hashed, so a token carried in a header is never stored in the clear.
 */
function requestKey(
  method: string,
  url: string,
  headers: Record<string, string> | undefined,
  body: string | undefined,
): string {
  // JSON-encode the sorted [name, value] pairs so the canonical form is INJECTIVE — a header value
  // containing a separator/newline can't be confused with a field boundary (two distinct header sets
  // could otherwise collide and wrongly dedup the JWT/IDOR case).
  const canonicalHeaders =
    headers === undefined
      ? ''
      : JSON.stringify(
          Object.entries(headers)
            .map(([k, v]): [string, string] => [k.toLowerCase(), v])
            .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
        );
  return createHash('sha256')
    .update([method.toUpperCase(), url, canonicalHeaders, body ?? ''].join(FIELD_SEP))
    .digest('hex');
}

/** Method + origin + path only — NEVER the query or body (may carry secrets/tokens, §5). */
function auditTarget(method: string, url: string): string {
  try {
    const u = new URL(url);
    return `${method.toUpperCase()} ${u.origin}${u.pathname}`;
  } catch {
    return method.toUpperCase();
  }
}

export function createHttpSend(ports: HttpSendPorts): HttpSender {
  const config = ports.config ?? DEFAULT_RATE_CONFIG;
  const sleep = ports.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = ports.now ?? ((): number => Date.now());
  // Per-scan rate state. In-memory: the tester burst is one process (the E2B sandbox).
  const rate = new Map<string, { delayMs: number; lastSentAt: number }>();

  return {
    async send(input: HttpSendInput): Promise<HttpSendOutput> {
      const target = await ports.resolveTarget(input.scanId);

      // 1. Authorization (launch invariant #1, defense in depth): never send without recorded
      //    authorization. In the normal flow approval already required it, so a miss here is a defect
      //    — fail loud (a typed, non-retryable error), never a soft outcome.
      if (target === undefined || !target.authorized) {
        await ports.audit({ scanId: input.scanId, action: 'http.send.refused_unauthorized' });
        throw new AuthorizationError('http.send refused: target not authorized for active testing');
      }

      // 2. Path-level scope (ADR-24): the firewall only sees the host; the path is enforced here. An
      //    out-of-scope-path attempt is a signal — refused + audited like a denied egress.
      if (!isUrlInScope(input.url, target.scope)) {
        await ports.audit({
          scanId: input.scanId,
          action: 'http.send.refused_out_of_scope',
          detail: auditTarget(input.method, input.url),
        });
        return { outcome: 'refused_out_of_scope' };
      }

      // 3. Dedup (ADR-27): a request already sent this scan is not re-sent. Checked BEFORE sending;
      //    the key is marked only AFTER a completed send (below), so a send that THROWS is re-tried
      //    on replay rather than silently dropped — critical for a zero-false-negative product.
      const key = requestKey(input.method, input.url, input.headers, input.body);
      if (await ports.alreadySent(input.scanId, key)) {
        await ports.audit({ scanId: input.scanId, action: 'http.send.deduplicated' });
        return { outcome: 'deduplicated' };
      }

      // 4. Rate posture (D-2; sequential per scan, ADR-25): honor the current min-delay before sending.
      const state = rate.get(input.scanId) ?? { delayMs: config.baseDelayMs, lastSentAt: 0 };
      const wait = Math.max(0, state.delayMs - (now() - state.lastSentAt));
      if (wait > 0) await sleep(wait);

      // 5. Send + audit. Never read a socket success as reachability — the observation is app-level.
      await ports.audit({
        scanId: input.scanId,
        action: 'http.send.request',
        detail: auditTarget(input.method, input.url),
      });
      const req: FetchRequest = {
        method: input.method,
        url: input.url,
        ...(input.headers !== undefined ? { headers: input.headers } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
      };

      let response;
      try {
        response = await ports.fetch(req);
      } finally {
        // Advance the rate posture even when the send THREW (a failing/throttling target still earns
        // backoff), so the next send is correctly spaced instead of firing immediately off stale state.
        const nextDelay =
          response !== undefined
            ? nextDelayMs(state.delayMs, response.status, config)
            : backoffAfterFailure(state.delayMs, config);
        rate.set(input.scanId, { delayMs: nextDelay, lastSentAt: now() });
      }

      // Only now — after a completed send — is the request marked, so a thrown send re-tries on replay.
      await ports.markSent(input.scanId, key);
      await ports.audit({ scanId: input.scanId, action: 'http.send.response', detail: `status=${response.status}` });
      return { outcome: 'sent', response };
    },
  };
}
