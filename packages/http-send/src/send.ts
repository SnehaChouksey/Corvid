import { createHash } from 'node:crypto';

import { AuthorizationError } from '@corvid/errors';
import { isUrlInScope } from '@corvid/scope';
import type { HttpSendInput, HttpSendOutput } from '@corvid/tool-contracts';

import { nextDelayMs } from './rate.ts';
import { DEFAULT_RATE_CONFIG, type FetchRequest, type HttpSender, type HttpSendPorts } from './types.ts';

// The one enforced order (Unit 4, ADR-24/25). Each guard runs BEFORE any network I/O except the
// send itself; every branch is audited (ADR-16). A tool never decides "verified" — this returns the
// raw response observation and the gate (Unit 5) decides.

/** Stable per-scan dedup key: method + full url + body. Identical requests collapse (idempotent replay). */
function requestKey(method: string, url: string, body: string | undefined): string {
  return createHash('sha256').update([method.toUpperCase(), url, body ?? ''].join('')).digest('hex');
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

      // 3. Dedup (ADR-27): a replayed node's identical request is not re-sent. Fail-closed in the port.
      const key = requestKey(input.method, input.url, input.body);
      const isNew = await ports.markNewRequest(input.scanId, key);
      if (!isNew) {
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
      const response = await ports.fetch(req);

      rate.set(input.scanId, { delayMs: nextDelayMs(state.delayMs, response.status, config), lastSentAt: now() });
      await ports.audit({ scanId: input.scanId, action: 'http.send.response', detail: `status=${response.status}` });
      return { outcome: 'sent', response };
    },
  };
}
