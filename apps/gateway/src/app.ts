import { type Auth, resolveUserId } from '@corvid/auth';
import {
  appendAudit,
  type AuditRow,
  confirmTargetAuthorization,
  createScanWithinCap,
  createTarget,
  type Database,
  type FindingRow,
  getAuditForScanOwner,
  getScanForOwner,
  getTargetForOwner,
  type HypothesisRow,
  listFindingsForScan,
  listHypothesesForScan,
  listScansForOwner,
  listTargetsForOwner,
  type ScanRow,
  setTargetProofOfControl,
  type TargetRow,
  updateTargetForOwner,
} from '@corvid/db';
import { AuthorizationError, isCorvidError } from '@corvid/errors';
import type { CorvidLogger } from '@corvid/logger';
import {
  challengeInstructions,
  hostForTarget,
  mintChallengeToken,
  pendingProof,
  type ProofPorts,
  readPendingToken,
  verifiedProof,
  verifyProofOfControl,
} from '@corvid/proof-of-control';
import type { ScanRuntimeService } from '@corvid/scan-runtime';
import { parseScopeRules } from '@corvid/scope';
import { type ScanCredentials, scanCredentialsSchema } from '@corvid/tool-contracts';
import { getConnInfo } from '@hono/node-server/conninfo';
import { zValidator } from '@hono/zod-validator';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { rateLimiter, type Store } from 'hono-rate-limiter';
import * as z from 'zod';

// The thin gateway (`02` §6): each handler resolves auth, validates input, calls an owner-scoped
// repo, shapes the response. No business logic here. Two safety properties are load-bearing:
// a not-owned resource is a 404 (never 403 — ADR-19, no cross-tenant existence leak), and abuse
// controls fail closed with a typed refusal (ADR-20).

export interface AppLimits {
  readonly windowMs: number;
  readonly max: number;
  /** Tighter limit for the unauthenticated auth surface (keyed by client IP). */
  readonly authMax: number;
  readonly concurrentScanCap: number;
}

/** Client IP for the auth-surface limiter: proxy header first, then the socket, else a shared bucket. */
function clientIp(c: Context<AppEnv>): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded !== undefined && forwarded.length > 0) {
    return forwarded.split(',')[0]!.trim();
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export interface AppDeps {
  readonly auth: Auth;
  readonly db: Database;
  readonly limits: AppLimits;
  readonly logger: CorvidLogger;
  /**
   * Optional per-limiter store factory (keyed by a stable prefix). Wire a Redis-backed store here so
   * rate-limit counters are shared across gateway instances (ADR-20); when absent, hono-rate-limiter
   * falls back to its in-memory store — correct for a single instance, per-process across many.
   */
  readonly rateLimitStore?: (prefix: string) => Store<AppEnv>;
  /**
   * IO ports for D-7 proof-of-control verification (DNS + a redirect-refusing HTTPS GET). Injected
   * so the gateway stays testable offline; the composition root wires node:dns/promises + fetch.
   */
  readonly proofPorts: ProofPorts;
  /**
   * Encrypt analyst-supplied scan credentials for storage at rest (D-1). Injected (a @corvid/crypto
   * cipher bound to ENCRYPTION_KEY in the composition root) so the gateway holds no key material and
   * the plaintext never leaves this call. Returns opaque ciphertext.
   */
  readonly encryptCredentials: (credentials: ScanCredentials) => string;
  /**
   * Signals the durable scan workflow (`02` §6): start a scan, submit the approval decision, cancel.
   * The gateway never drives LangGraph itself — it calls this service (co-located in v1, ADR-33).
   */
  readonly scanRuntime: ScanRuntimeService;
}

export type AppEnv = { Variables: { userId: string } };

// Response shaping — the mapping from a snake_case-backed DB row to the app's JSON happens here,
// once (§11). These select the fields the dashboard reads and deliberately omit internals: a
// hypothesis's `fingerprint` (dedup plumbing) and a target's raw `proof_of_control` token are not
// surfaced. `findings` are verified-only by construction (the store holds no unverified row, §4.4),
// so there is nothing to filter here — the DTO can't leak an unverified finding.

function toTargetSummary(t: TargetRow) {
  return {
    id: t.id,
    url: t.url,
    scopeRules: t.scopeRules,
    authorized: t.authorizationConfirmedAt !== null,
    authorizationConfirmedAt: t.authorizationConfirmedAt,
    authorizedBy: t.authorizedBy,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

function toScanSummary(s: ScanRow) {
  return {
    id: s.id,
    targetId: s.targetId,
    status: s.status,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
    createdAt: s.createdAt,
  };
}

function toHypothesis(h: HypothesisRow) {
  // The approval gate reads this: vuln class, endpoint, rationale, and the intended payload/tool
  // from `plan` (`01` §6, `02` §6). Status distinguishes pending/approved/rejected/tested.
  return {
    id: h.id,
    vulnClass: h.vulnClass,
    endpoint: h.endpoint,
    rationale: h.rationale,
    status: h.status,
    plan: h.plan,
    createdAt: h.createdAt,
  };
}

function toFinding(f: FindingRow) {
  return {
    id: f.id,
    vulnClass: f.vulnClass,
    payload: f.payload,
    proof: f.proof,
    severity: f.severity,
    reportedAt: f.reportedAt,
  };
}

function toAuditEntry(a: AuditRow) {
  return { id: a.id, action: a.action, actor: a.actor, detail: a.detail, timestamp: a.timestamp };
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Public auth surface (Better Auth owns sign-up/sign-in/session). It's the one endpoint an
  // unauthenticated attacker can reach, so it gets its own IP-keyed rate limit (ADR-20) — the
  // per-user limiter below can't cover it (there is no user yet). Registered before the handler so
  // it runs first, and before the protected sub-app so /api/auth/* is never routed through the
  // user-auth guard.
  app.use(
    '/api/auth/*',
    rateLimiter<AppEnv>({
      windowMs: deps.limits.windowMs,
      limit: deps.limits.authMax,
      standardHeaders: 'draft-7',
      keyGenerator: clientIp,
      ...(deps.rateLimitStore !== undefined ? { store: deps.rateLimitStore('auth') } : {}),
    }),
  );
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
      ...(deps.rateLimitStore !== undefined ? { store: deps.rateLimitStore('user') } : {}),
    }),
  );

  const createTargetSchema = z
    .object({
      url: z.url(),
      scopeRules: z.object({
        hosts: z.array(z.string().min(1)).min(1),
        includePaths: z.array(z.string()).optional(),
        excludePaths: z.array(z.string()).optional(),
      }),
    })
    .strict(); // reject unknown keys — a client can't smuggle e.g. authorizationConfirmedAt

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

  api.get('/targets', async (c) => {
    const rows = await listTargetsForOwner(deps.db, c.get('userId'));
    return c.json({ targets: rows.map(toTargetSummary) });
  });

  api.get('/targets/:id', async (c) => {
    const userId = c.get('userId');
    const target = await getTargetForOwner(deps.db, userId, c.req.param('id'));
    if (target === undefined) {
      throw new HTTPException(404, { message: 'Not found' }); // 404-not-403 (ADR-19)
    }
    return c.json(toTargetSummary(target));
  });

  const patchTargetSchema = z
    .object({
      url: z.url().optional(),
      scopeRules: z
        .object({
          hosts: z.array(z.string().min(1)).min(1),
          includePaths: z.array(z.string()).optional(),
          excludePaths: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .strict()
    .refine((v) => v.url !== undefined || v.scopeRules !== undefined, {
      message: 'provide url and/or scopeRules to update',
    });

  // Editing url or scope INVALIDATES a prior authorization (`01` §3): the repo clears the
  // proof-of-control triplet so a widened scope can never inherit an old approval. The target
  // returns to Unauthorized and must re-earn authorization via the D-7 flow.
  api.patch('/targets/:id', zValidator('json', patchTargetSchema), async (c) => {
    const userId = c.get('userId');
    const body = c.req.valid('json');
    if (body.scopeRules !== undefined) {
      parseScopeRules(body.scopeRules); // reject invalid/dangerous scope before persisting → 403
    }
    const updated = await updateTargetForOwner(deps.db, userId, c.req.param('id'), {
      ...(body.url !== undefined ? { url: body.url } : {}),
      ...(body.scopeRules !== undefined ? { scopeRules: body.scopeRules } : {}),
    });
    if (updated === undefined) {
      throw new HTTPException(404, { message: 'Not found' });
    }
    return c.json(toTargetSummary(updated));
  });

  const authorizeSchema = z.object({ method: z.enum(['dns', 'well_known']).optional() }).strict();

  // D-7 proof-of-control (ADR-D7). One idempotent endpoint drives a challenge/response: the first
  // call (no pending token) MINTS a token and returns placement instructions (202 pending); a later
  // call (token exists) VERIFIES it via DNS TXT or the /.well-known/ file and, only on proof, stamps
  // authorization (actor + timestamp + evidence). A bare click can never authorize — the proof can't
  // be faked. `verifyProofOfControl` refuses a dangerous/dangerous-resolving host (SSRF guard), which
  // surfaces as a 403; a target that can't prove control simply stays Unauthorized.
  api.post('/targets/:id/authorize', zValidator('json', authorizeSchema), async (c) => {
    const userId = c.get('userId');
    const targetId = c.req.param('id');
    const target = await getTargetForOwner(deps.db, userId, targetId);
    if (target === undefined) {
      throw new HTTPException(404, { message: 'Not found' });
    }
    // Idempotent: already authorized → report it, never re-mint or re-verify.
    if (target.authorizationConfirmedAt !== null) {
      return c.json({ status: 'authorized', authorizationConfirmedAt: target.authorizationConfirmedAt });
    }

    const host = hostForTarget(target.url); // AuthorizationError → 403 on a bad/host-less URL

    const existing = readPendingToken(target.proofOfControl);
    if (existing === null) {
      // Issue the challenge; the user places it, then calls again to verify.
      const token = mintChallengeToken();
      await setTargetProofOfControl(deps.db, userId, targetId, { ...pendingProof(token) });
      return c.json({ status: 'pending', instructions: challengeInstructions(host, token) }, 202);
    }

    const { method } = c.req.valid('json');
    const result = await verifyProofOfControl(
      host,
      existing,
      deps.proofPorts,
      method !== undefined ? { method } : {},
    );
    if (!result.verified) {
      return c.json(
        { status: 'pending', instructions: challengeInstructions(host, existing), reason: result.reason },
        202,
      );
    }
    const proof = { ...verifiedProof(existing, result.method, result.evidence) };
    const updated = await confirmTargetAuthorization(deps.db, userId, targetId, {
      authorizedBy: userId,
      proofOfControl: proof,
    });
    // Audit the authorization at the point it happens (ADR-16); method only, never the token (§5).
    await appendAudit(deps.db, { action: 'target.authorized', actor: userId, detail: `method=${result.method}` });
    return c.json({
      status: 'authorized',
      method: result.method,
      authorizationConfirmedAt: updated?.authorizationConfirmedAt ?? null,
    });
  });

  // `credentials` is accepted as unknown here and parsed with the shared schema below, NOT via
  // zValidator — a zValidator failure echoes the offending input in its response, and this input is
  // secret material (§5). We validate it separately and never reflect its contents.
  const createScanSchema = z.object({ targetId: z.uuid(), credentials: z.unknown().optional() }).strict();

  api.post('/scans', zValidator('json', createScanSchema), async (c) => {
    const userId = c.get('userId');
    const { targetId, credentials } = c.req.valid('json');

    const target = await getTargetForOwner(deps.db, userId, targetId);
    if (target === undefined) {
      throw new HTTPException(404, { message: 'Not found' });
    }
    // Workflow refuses to start without recorded authorization for the current scope (§7, layer 1).
    // Assert the POSITIVE (a real confirmed date) so a missing/undefined value fails closed.
    const confirmedAt = target.authorizationConfirmedAt;
    if (!(confirmedAt instanceof Date) || Number.isNaN(confirmedAt.getTime())) {
      throw new AuthorizationError('Target is not authorized for scanning');
    }

    // D-1: validate + encrypt analyst-supplied credentials before they touch the DB. A parse failure
    // is a generic 400 with NO issue detail — the issues could reflect the secret back (§5).
    let credentialsEncrypted: string | undefined;
    if (credentials !== undefined) {
      const parsed = scanCredentialsSchema.safeParse(credentials);
      if (!parsed.success) {
        throw new HTTPException(400, { message: 'Invalid credentials' });
      }
      credentialsEncrypted = deps.encryptCredentials(parsed.data);
    }

    // Per-user concurrent-scan cap (ADR-20), enforced ATOMICALLY at workflow start — the count and
    // insert share one advisory-locked transaction so parallel starts can't fail open. null = capped.
    const scan = await createScanWithinCap(deps.db, {
      ownerId: userId,
      targetId,
      cap: deps.limits.concurrentScanCap,
      ...(credentialsEncrypted !== undefined ? { credentialsEncrypted } : {}),
    });
    if (scan === null) {
      return c.json({ error: 'concurrent_scan_cap_reached', cap: deps.limits.concurrentScanCap }, 429);
    }
    // Signal the workflow to begin (fire-and-forget; it runs to the approval interrupt in the
    // background, durable across a crash — ADR-27). The row is already persisted, so the response
    // doesn't wait on the crawl.
    deps.scanRuntime.start(scan.id, userId);
    return c.json({ id: scan.id, status: scan.status }, 201);
  });

  api.get('/scans', async (c) => {
    const rows = await listScansForOwner(deps.db, c.get('userId'));
    return c.json({ scans: rows.map(toScanSummary) });
  });

  // Resolve a scan the caller owns, or 404 (never 403 — no cross-tenant existence leak, ADR-19).
  // Every per-scan sub-resource read below gates on ownership HERE first, then reads the scan-scoped
  // rows: the child repos (`listHypothesesForScan` etc.) are trusted-caller reads by scan id, so the
  // owner check must happen at this boundary, not inside them.
  const requireOwnedScan = async (c: Context<AppEnv>): Promise<ScanRow> => {
    const scanId = c.req.param('id');
    const scan =
      scanId === undefined ? undefined : await getScanForOwner(deps.db, c.get('userId'), scanId);
    if (scan === undefined) {
      throw new HTTPException(404, { message: 'Not found' });
    }
    return scan;
  };

  api.get('/scans/:id', async (c) => {
    const scan = await requireOwnedScan(c);
    return c.json(toScanSummary(scan));
  });

  api.get('/scans/:id/hypotheses', async (c) => {
    const scan = await requireOwnedScan(c);
    const rows = await listHypothesesForScan(deps.db, scan.id);
    return c.json({ hypotheses: rows.map(toHypothesis) });
  });

  api.get('/scans/:id/findings', async (c) => {
    const scan = await requireOwnedScan(c);
    const rows = await listFindingsForScan(deps.db, scan.id);
    return c.json({ findings: rows.map(toFinding) });
  });

  api.get('/scans/:id/audit', async (c) => {
    const scan = await requireOwnedScan(c);
    const rows = await getAuditForScanOwner(deps.db, c.get('userId'), scan.id);
    return c.json({ audit: rows.map(toAuditEntry) });
  });

  // The human approval gate (Flow D, `01` §6) — the safety-critical resume. `approvedHypotheses` may
  // be empty (approve nothing → a clean zero-finding scan). The service records the decision durably
  // (owner-scoped, status-guarded, audited with the human as actor) BEFORE any test runs, then
  // resumes the workflow with exactly the approved set. Nothing is pre-approved; silence never
  // consents (no timeout path here).
  const approvalSchema = z.object({ approvedHypotheses: z.array(z.uuid()) }).strict();
  api.post('/scans/:id/approvals', zValidator('json', approvalSchema), async (c) => {
    const scan = await requireOwnedScan(c); // 404 for a non-owner (ADR-19)
    const { approvedHypotheses } = c.req.valid('json');
    const outcome = await deps.scanRuntime.submitApproval(scan.id, c.get('userId'), { approvedHypotheses });
    switch (outcome.kind) {
      case 'accepted':
        return c.json({ status: 'accepted', approved: outcome.approved, rejected: outcome.rejected });
      case 'not_awaiting':
        // Stale/duplicate submit — the scan is no longer at the gate. Typed refusal, never a 500.
        return c.json({ error: 'not_awaiting_approval' }, 409);
      case 'invalid_hypotheses':
        return c.json({ error: 'invalid_hypotheses', unknown: outcome.unknown }, 400);
    }
  });

  api.post('/scans/:id/cancel', async (c) => {
    const scan = await requireOwnedScan(c);
    const outcome = await deps.scanRuntime.cancel(scan.id, c.get('userId'));
    switch (outcome) {
      case 'cancelled':
        return c.json({ status: 'cancelled' });
      case 'not_found':
        throw new HTTPException(404, { message: 'Not found' });
      case 'not_cancellable':
        return c.json({ error: 'not_cancellable' }, 409);
    }
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
