import { isCorvidError } from '@corvid/errors';
import type { CorvidLogger } from '@corvid/logger';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import * as z from 'zod';

import { classifyHost } from './capture.ts';
import type { OobStore } from './store.ts';

// The self-hosted OOB callback listener (ADR-09, D-16). One Hono app plays two roles, told apart by
// the request Host (see capture.ts):
//   - control plane on the apex host: `POST /register` mints a token; `GET /callbacks/:token` is the
//     verifier's read. These are internal (reached over the private interface / apex host).
//   - callback capture on `<token>.<OOB_HOST>`: ANY path is a callback — a target's server-side fetch
//     reached us. It is recorded (correlated to a registered token) and answered with a benign 200,
//     so we never leak which tokens are live and never reflect attacker-controlled content.
// Every registration and every recorded callback is audited (ADR-16). The gate NEVER runs here — the
// listener only records the out-of-band fact; `@corvid/verify` decides `verified` (ADR-01).

export interface OobAuditEntry {
  readonly scanId: string;
  readonly action: string;
  readonly detail?: string;
}

export interface AuditSink {
  append(entry: OobAuditEntry): Promise<void>;
}

export interface OobAppDeps {
  readonly store: OobStore;
  readonly audit: AuditSink;
  readonly logger: CorvidLogger;
  /** The wildcard apex the listener owns; a callback host is `<token>.<oobHost>`. */
  readonly oobHost: string;
}

const registerBodySchema = z.object({ scanId: z.uuid() }).strict();

export function createOobApp(deps: OobAppDeps): Hono {
  const app = new Hono();

  // Host-based routing runs first: a token-subdomain request is a callback (recorded + 200), a
  // foreign host is ignored (404), and only an apex request falls through to the control routes.
  // This ensures a callback that hits an arbitrary path (e.g. `/register`) is treated as a callback,
  // not misrouted into the control plane.
  app.use('*', async (c, next) => {
    const classification = classifyHost(c.req.header('host'), deps.oobHost);
    if (classification.kind === 'callback') {
      const record = await deps.store.markCalledBack(classification.token);
      if (record.recorded && record.scanId !== undefined) {
        await deps.audit.append({
          scanId: record.scanId,
          action: 'oob.callback',
          detail: `token=${classification.token.slice(0, 8)}`,
        });
        deps.logger.info({ scanId: record.scanId }, 'oob callback recorded');
      }
      // Benign, constant response regardless of whether the token was live — no oracle for probers.
      return c.text('ok', 200);
    }
    if (classification.kind === 'ignore') {
      return c.text('not found', 404);
    }
    return next();
  });

  app.post('/register', zValidator('json', registerBodySchema), async (c) => {
    const { scanId } = c.req.valid('json');
    const token = await deps.store.register(scanId);
    await deps.audit.append({ scanId, action: 'oob.register', detail: `token=${token.slice(0, 8)}` });
    return c.json({ token, host: deps.oobHost });
  });

  app.get('/callbacks/:token', async (c) => {
    const calledBack = await deps.store.wasCalledBack(c.req.param('token'));
    return c.json({ calledBack });
  });

  app.onError((err, c) => {
    // Log SAFE fields only — never the raw error message, which could carry connection details (§5).
    deps.logger.error({ err_name: err instanceof Error ? err.name : 'unknown' }, 'oob-listener error');
    const status = isCorvidError(err) && err.name === 'InfraError' ? 503 : 500;
    return c.json({ error: 'internal_error' }, status);
  });

  return app;
}
