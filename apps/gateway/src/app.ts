import { type Auth, resolveUserId } from '@corvid/auth';
import {
  countActiveScansForOwner,
  createScan,
  createTarget,
  type Database,
  getTargetForOwner,
} from '@corvid/db';
import { AuthorizationError, isCorvidError } from '@corvid/errors';
import type { CorvidLogger } from '@corvid/logger';
import { parseScopeRules } from '@corvid/scope';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { rateLimiter } from 'hono-rate-limiter';
import * as z from 'zod';

// The thin gateway (`02` §6): each handler resolves auth, validates input, calls an owner-scoped
// repo, shapes the response. No business logic here. Two safety properties are load-bearing:
// a not-owned resource is a 404 (never 403 — ADR-19, no cross-tenant existence leak), and abuse
// controls fail closed with a typed refusal (ADR-20).

export interface AppLimits {
  readonly windowMs: number;
  readonly max: number;
  readonly concurrentScanCap: number;
}

export interface AppDeps {
  readonly auth: Auth;
  readonly db: Database;
  readonly limits: AppLimits;
  readonly logger: CorvidLogger;
}

export type AppEnv = { Variables: { userId: string } };

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Public auth surface (Better Auth owns sign-up/sign-in/session). Registered before the protected
  // sub-app so /api/auth/* is handled here, never routed through the auth guard below.
  app.on(['POST', 'GET'], '/api/auth/*', (c) => deps.auth.handler(c.req.raw));

  const api = new Hono<AppEnv>();

  // 1. Auth resolution — every protected request resolves to exactly one users.id (ADR-19).
  api.use('*', async (c, next) => {
    const userId = await resolveUserId(deps.auth, c.req.raw.headers);
    if (userId === null) {
      throw new HTTPException(401, { message: 'Authentication required' });
    }
    c.set('userId', userId);
    await next();
  });

  // 2. Per-user rate limit (ADR-20) — keyed on the resolved user id, never IP; emits Retry-After.
  api.use(
    '*',
    rateLimiter<AppEnv>({
      windowMs: deps.limits.windowMs,
      limit: deps.limits.max,
      standardHeaders: 'draft-7',
      keyGenerator: (c) => c.get('userId'),
    }),
  );

  const createTargetSchema = z.object({
    url: z.url(),
    scopeRules: z.object({
      hosts: z.array(z.string().min(1)).min(1),
      includePaths: z.array(z.string()).optional(),
      excludePaths: z.array(z.string()).optional(),
    }),
  });

  api.post('/targets', zValidator('json', createTargetSchema), async (c) => {
    const userId = c.get('userId');
    const body = c.req.valid('json');
    parseScopeRules(body.scopeRules); // invalid scope → AuthorizationError → 403
    const target = await createTarget(deps.db, {
      ownerId: userId,
      url: body.url,
      scopeRules: body.scopeRules,
    });
    return c.json({ id: target.id }, 201);
  });

  api.get('/targets/:id', async (c) => {
    const userId = c.get('userId');
    const target = await getTargetForOwner(deps.db, userId, c.req.param('id'));
    if (target === undefined) {
      throw new HTTPException(404, { message: 'Not found' }); // 404-not-403 (ADR-19)
    }
    return c.json({
      id: target.id,
      url: target.url,
      authorizationConfirmedAt: target.authorizationConfirmedAt,
    });
  });

  const createScanSchema = z.object({ targetId: z.uuid() });

  api.post('/scans', zValidator('json', createScanSchema), async (c) => {
    const userId = c.get('userId');
    const { targetId } = c.req.valid('json');

    const target = await getTargetForOwner(deps.db, userId, targetId);
    if (target === undefined) {
      throw new HTTPException(404, { message: 'Not found' });
    }
    // Workflow refuses to start without recorded authorization for the current scope (§7, layer 1).
    if (target.authorizationConfirmedAt === null) {
      throw new AuthorizationError('Target is not authorized for scanning');
    }
    // Per-user concurrent-scan cap, checked at workflow start (ADR-20) — typed refusal, not a 500.
    const active = await countActiveScansForOwner(deps.db, userId);
    if (active >= deps.limits.concurrentScanCap) {
      return c.json({ error: 'concurrent_scan_cap_reached', cap: deps.limits.concurrentScanCap }, 429);
    }
    const scan = await createScan(deps.db, { ownerId: userId, targetId, status: 'authorizing' });
    return c.json({ id: scan.id, status: scan.status }, 201);
  });

  app.route('/api', api);

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return err.getResponse();
    }
    if (isCorvidError(err)) {
      if (err.kind === 'authorization') {
        return c.json({ error: 'forbidden' }, 403);
      }
      // config/target/infra: don't leak detail; log structured (never console) then generic 500.
      deps.logger.error({ err }, 'request failed');
      return c.json({ error: 'internal_error' }, 500);
    }
    deps.logger.error({ err }, 'unhandled error');
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}
