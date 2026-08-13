import { appendAudit, getTargetForScan, type Database } from '@corvid/db';
import type { CorvidLogger } from '@corvid/logger';
import type { HttpRequestDedup } from '@corvid/redis';
import { parseScopeRules } from '@corvid/scope';
import type { HttpResponse } from '@corvid/tool-contracts';

import type { FetchRequest, HttpSendPorts, RateConfig } from './types.ts';

// Real ports: bind the sender to @corvid/db (target row + audit), @corvid/redis (dedup), and real
// `fetch`. Kept out of send.ts so the core enforcement stays pure and testable with fakes. `dedupFor`
// is a factory rather than a raw Redis client so this package needn't depend on ioredis directly.

async function realFetch(req: FetchRequest): Promise<HttpResponse> {
  const startedAt = Date.now();
  const res = await fetch(req.url, {
    method: req.method,
    ...(req.headers !== undefined ? { headers: req.headers } : {}),
    ...(req.body !== undefined ? { body: req.body } : {}),
  });
  const body = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: res.status, headers, body, timingMs: Date.now() - startedAt };
}

export interface HttpSendAdapterDeps {
  readonly db: Database;
  /** Build the per-scan dedup (e.g. `(scanId) => new HttpRequestDedup(redis, scanId)`). */
  readonly dedupFor: (scanId: string) => HttpRequestDedup;
  /** Override the network send — defaults to real `fetch` (used inside the E2B sandbox in prod). */
  readonly fetchImpl?: (req: FetchRequest) => Promise<HttpResponse>;
  readonly config?: RateConfig;
  readonly logger?: CorvidLogger;
}

export function createHttpSendPorts(deps: HttpSendAdapterDeps): HttpSendPorts {
  return {
    resolveTarget: async (scanId) => {
      const row = await getTargetForScan(deps.db, scanId);
      if (row === undefined) return undefined;
      // parseScopeRules is the ONE authoritative, fail-closed scope validator (rejects dangerous hosts).
      return { scope: parseScopeRules(row.scopeRules), authorized: row.authorizationConfirmedAt !== null };
    },
    alreadySent: (scanId, key) => deps.dedupFor(scanId).has(key),
    markSent: (scanId, key) =>
      deps
        .dedupFor(scanId)
        .markSent(key)
        .then(() => undefined),
    fetch: deps.fetchImpl ?? realFetch,
    audit: (entry) =>
      appendAudit(deps.db, {
        scanId: entry.scanId,
        action: entry.action,
        actor: 'http.send',
        ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
      }),
    ...(deps.config !== undefined ? { config: deps.config } : {}),
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
  };
}
