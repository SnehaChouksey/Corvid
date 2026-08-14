import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';

import { createAuth, type Auth } from '@corvid/auth';
import { createCipher } from '@corvid/crypto';
import { createDb, type DbHandle, runMigrations, schema } from '@corvid/db';
import { createLogger } from '@corvid/logger';
import type { ProofPorts } from '@corvid/proof-of-control';
import { createRedis, honoRateLimitClient } from '@corvid/redis';
import type { ScanRuntimeService } from '@corvid/scan-runtime';
import type { ApprovalOutcome, CancelOutcome } from '@corvid/tool-contracts';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { RedisStore } from 'hono-rate-limiter';

import { type AppEnv, type AppLimits, createApp } from '../src/app.ts';

// End-to-end gateway behavior over real HTTP (via app.request) against a real Postgres + Better
// Auth. Proves the Unit 1 safety DoD lines that only exist at the HTTP boundary: cross-tenant 404,
// refuse-unauthorized scan start, and abuse controls firing with typed refusals. Opt-in via
// DATABASE_URL.

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const ORIGIN = 'http://localhost';

if (DATABASE_URL === undefined) {
  test('gateway integration (skipped — set DATABASE_URL with a running Postgres)', { skip: true }, () => {});
} else {
  runIntegrationTests(DATABASE_URL);
}

function runIntegrationTests(databaseUrl: string): void {
  let handle: DbHandle;
  let auth: Auth;
  const logger = createLogger({ level: 'silent', service: 'gateway-test' });

  before(async () => {
    handle = createDb(databaseUrl);
    await runMigrations(handle);
    // No TRUNCATE (audit log is immutable); tests use unique emails so prior rows don't interfere.
    auth = createAuth({
      database: handle.db,
      secret: 'test-secret-not-a-real-key-0123456789',
      baseURL: ORIGIN,
      trustedOrigins: [ORIGIN],
    });
  });

  after(async () => {
    await handle.pool.end();
  });

  // Proof-of-control IO is injected; the default fake proves nothing (resolves to a benign public IP
  // so the SSRF guard passes, but no TXT/well-known match), so authorization is never granted unless
  // a test wires a fake that "places" the token.
  const noProof: ProofPorts = {
    resolveTxt: async () => [],
    resolveHostIps: async () => ['93.184.216.34'],
    fetchText: async () => ({ ok: false, status: 404, body: '' }),
  };
  // A real cipher with a throwaway key, so the credential path is proven end to end (encrypt on the
  // way in, decrypt to assert the round-trip).
  const cipher = createCipher(randomBytes(32));
  const encryptCredentials = (creds: unknown): string => cipher.encrypt(JSON.stringify(creds));

  // The scan-runtime service is injected; a fake records calls and returns canned outcomes so the
  // HTTP layer (owner check + outcome→status mapping) is tested without a live LangGraph.
  interface FakeRuntime {
    readonly service: ScanRuntimeService;
    readonly calls: {
      start: { scanId: string; userId: string }[];
      approvals: { scanId: string; ownerId: string; approved: readonly string[] }[];
      cancels: { scanId: string; ownerId: string }[];
    };
  }
  function fakeRuntime(opts: { approval?: ApprovalOutcome; cancel?: CancelOutcome } = {}): FakeRuntime {
    const calls: FakeRuntime['calls'] = { start: [], approvals: [], cancels: [] };
    return {
      calls,
      service: {
        start: (scanId, userId) => {
          calls.start.push({ scanId, userId });
        },
        submitApproval: async (scanId, ownerId, sub) => {
          calls.approvals.push({ scanId, ownerId, approved: sub.approvedHypotheses });
          return opts.approval ?? { kind: 'accepted', approved: [...sub.approvedHypotheses], rejected: [] };
        },
        cancel: async (scanId, ownerId) => {
          calls.cancels.push({ scanId, ownerId });
          return opts.cancel ?? 'cancelled';
        },
      },
    };
  }
  const noRuntime = fakeRuntime().service;

  const makeApp = (
    limits: AppLimits,
    proofPorts: ProofPorts = noProof,
    scanRuntime: ScanRuntimeService = noRuntime,
  ): Hono<AppEnv> =>
    createApp({ auth, db: handle.db, limits, logger, proofPorts, encryptCredentials, scanRuntime });
  const defaultLimits: AppLimits = { windowMs: 60_000, max: 100, authMax: 100, concurrentScanCap: 5 };

  async function signUp(app: Hono<AppEnv>, email: string): Promise<string> {
    const res = await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email, password: 'a-strong-password', name: 'Analyst' }),
    });
    assert.ok(res.status === 200 || res.status === 201, `sign-up failed: ${res.status} ${await res.text()}`);
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(';', 1)[0])
      .join('; ');
    assert.ok(cookie.length > 0, 'expected a session cookie from sign-up');
    return cookie;
  }

  const authed = (cookie: string, init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: { ...(init.headers as Record<string, string>), cookie, origin: ORIGIN },
  });

  test('a target is a 404 (not 403) for a non-owner over HTTP (ADR-19)', async () => {
    const app = makeApp(defaultLimits);
    const cookieA = await signUp(app, `a-${Date.now()}@example.com`);
    const cookieB = await signUp(app, `b-${Date.now()}@example.com`);

    const created = await app.request(
      '/api/targets',
      authed(cookieA, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://app.example.com', scopeRules: { hosts: ['app.example.com'] } }),
      }),
    );
    assert.equal(created.status, 201);
    const { id } = (await created.json()) as { id: string };

    assert.equal((await app.request(`/api/targets/${id}`, authed(cookieA))).status, 200);
    assert.equal((await app.request(`/api/targets/${id}`, authed(cookieB))).status, 404); // no leak
    assert.equal((await app.request(`/api/targets/${id}`)).status, 401); // unauthenticated
  });

  test('starting a scan on an unauthorized target is refused (§7 layer 1)', async () => {
    const app = makeApp(defaultLimits);
    const cookie = await signUp(app, `unauth-${Date.now()}@example.com`);
    const created = await app.request(
      '/api/targets',
      authed(cookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://x.example.com', scopeRules: { hosts: ['x.example.com'] } }),
      }),
    );
    const { id } = (await created.json()) as { id: string };

    const res = await app.request(
      '/api/scans',
      authed(cookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetId: id }),
      }),
    );
    assert.equal(res.status, 403); // authorization refusal, not a 500
    assert.deepEqual(await res.json(), { error: 'forbidden' });
  });

  test('per-user rate limit refuses excess with a typed 429 (ADR-20)', async () => {
    const app = makeApp({ ...defaultLimits, max: 2 });
    const cookie = await signUp(app, `rl-${Date.now()}@example.com`);
    // Two requests allowed, the third refused — even 404s count toward the limit.
    assert.equal((await app.request('/api/targets/00000000-0000-0000-0000-000000000000', authed(cookie))).status, 404);
    assert.equal((await app.request('/api/targets/00000000-0000-0000-0000-000000000000', authed(cookie))).status, 404);
    assert.equal((await app.request('/api/targets/00000000-0000-0000-0000-000000000000', authed(cookie))).status, 429);
  });

  test('per-user concurrent-scan cap refuses excess with a typed 429 (ADR-20)', async () => {
    const app = makeApp({ ...defaultLimits, concurrentScanCap: 1 });
    const cookie = await signUp(app, `cap-${Date.now()}@example.com`);
    const created = await app.request(
      '/api/targets',
      authed(cookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://cap.example.com', scopeRules: { hosts: ['cap.example.com'] } }),
      }),
    );
    const { id } = (await created.json()) as { id: string };
    // Simulate recorded authorization (proof-of-control flow is Unit 6) so the scan can start.
    await handle.db
      .update(schema.targets)
      .set({ authorizationConfirmedAt: new Date() })
      .where(eq(schema.targets.id, id));

    const startScan = () =>
      app.request(
        '/api/scans',
        authed(cookie, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ targetId: id }),
        }),
      );

    assert.equal((await startScan()).status, 201); // first within cap
    const capped = await startScan();
    assert.equal(capped.status, 429); // second refused
    assert.deepEqual(await capped.json(), { error: 'concurrent_scan_cap_reached', cap: 1 });
  });

  async function createTarget(app: Hono<AppEnv>, cookie: string, host: string): Promise<string> {
    const res = await app.request(
      '/api/targets',
      authed(cookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: `https://${host}`, scopeRules: { hosts: [host] } }),
      }),
    );
    assert.equal(res.status, 201);
    return ((await res.json()) as { id: string }).id;
  }

  test('editing scope returns the target to Unauthorized (`01` §3, Unit 6)', async () => {
    const app = makeApp(defaultLimits);
    const cookie = await signUp(app, `patch-${Date.now()}@example.com`);
    const id = await createTarget(app, cookie, 'patch.example.com');

    // Stamp authorization directly (the D-7 flow lands in a later slab); the invariant under test is
    // that a scope edit CLEARS it, regardless of how it was earned.
    await handle.db
      .update(schema.targets)
      .set({ authorizationConfirmedAt: new Date(), authorizedBy: 'test', proofOfControl: { method: 'dns' } })
      .where(eq(schema.targets.id, id));
    const before = await app.request(`/api/targets/${id}`, authed(cookie));
    assert.equal(((await before.json()) as { authorized: boolean }).authorized, true);

    const patched = await app.request(
      `/api/targets/${id}`,
      authed(cookie, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scopeRules: { hosts: ['patch.example.com', 'widened.example.com'] } }),
      }),
    );
    assert.equal(patched.status, 200);
    assert.equal(((await patched.json()) as { authorized: boolean }).authorized, false); // approval discarded

    // The cleared authorization is durable: a scan can no longer start.
    const scan = await app.request(
      '/api/scans',
      authed(cookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetId: id }),
      }),
    );
    assert.equal(scan.status, 403);
  });

  test('D-7: a target is authorized only after proof-of-control is verified (Unit 6)', async () => {
    // A stateful fake: DNS resolves TXT to whatever token has been "placed". Start with none placed.
    let placed: string | null = null;
    const proofPorts: ProofPorts = {
      resolveTxt: async () => (placed === null ? [] : [[placed]]),
      resolveHostIps: async () => ['93.184.216.34'],
      fetchText: async () => ({ ok: false, status: 404, body: '' }),
    };
    const app = makeApp(defaultLimits, proofPorts);
    const cookie = await signUp(app, `d7-${Date.now()}@example.com`);
    const id = await createTarget(app, cookie, 'd7.example.com');

    const authorize = () =>
      app.request(
        `/api/targets/${id}/authorize`,
        authed(cookie, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }),
      );

    // First call issues a challenge (202 pending) and returns the token to place.
    const challenge = await authorize();
    assert.equal(challenge.status, 202);
    const body = (await challenge.json()) as {
      status: string;
      instructions: { token: string; dns: { value: string } };
    };
    assert.equal(body.status, 'pending');
    assert.ok(body.instructions.token.length > 0);

    // Before placing the record, verification fails and the target stays Unauthorized.
    const stillPending = await authorize();
    assert.equal(stillPending.status, 202);
    const t1 = await app.request(`/api/targets/${id}`, authed(cookie));
    assert.equal(((await t1.json()) as { authorized: boolean }).authorized, false);

    // Place the token in DNS, then verify — now authorized.
    placed = body.instructions.dns.value;
    const verified = await authorize();
    assert.equal(verified.status, 200);
    assert.equal(((await verified.json()) as { status: string }).status, 'authorized');
    const t2 = await app.request(`/api/targets/${id}`, authed(cookie));
    assert.equal(((await t2.json()) as { authorized: boolean }).authorized, true);

    // And the scan gate now opens.
    const scan = await app.request(
      '/api/scans',
      authed(cookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetId: id }),
      }),
    );
    assert.equal(scan.status, 201);
  });

  test('scan sub-resources are 404 for a non-owner (no cross-tenant leak, ADR-19)', async () => {
    const app = makeApp(defaultLimits);
    const cookieA = await signUp(app, `owner-${Date.now()}@example.com`);
    const cookieB = await signUp(app, `intruder-${Date.now()}@example.com`);
    const id = await createTarget(app, cookieA, 'owned.example.com');
    await handle.db
      .update(schema.targets)
      .set({ authorizationConfirmedAt: new Date() })
      .where(eq(schema.targets.id, id));
    const started = await app.request(
      '/api/scans',
      authed(cookieA, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetId: id }),
      }),
    );
    const scanId = ((await started.json()) as { id: string }).id;

    // Owner reads succeed; the intruder gets 404 on the scan AND every sub-resource.
    for (const path of ['', '/hypotheses', '/findings', '/audit']) {
      assert.equal((await app.request(`/api/scans/${scanId}${path}`, authed(cookieA))).status, 200);
      assert.equal((await app.request(`/api/scans/${scanId}${path}`, authed(cookieB))).status, 404);
    }
  });

  test('D-1: scan credentials are stored encrypted and round-trip (Unit 6)', async () => {
    const app = makeApp(defaultLimits);
    const cookie = await signUp(app, `creds-${Date.now()}@example.com`);
    const id = await createTarget(app, cookie, 'creds.example.com');
    await handle.db
      .update(schema.targets)
      .set({ authorizationConfirmedAt: new Date() })
      .where(eq(schema.targets.id, id));

    const credentials = {
      jwtSample: 'eyJhbGciOiJIUzI1NiJ9.e30.sig',
      crawlLogin: { loginUrl: 'https://creds.example.com/login', username: 'analyst', password: 'sup3r-secret' },
      idorSessions: {
        primary: { label: 'admin', headers: { Cookie: 'session=admin-token' } },
        secondary: { label: 'user', headers: { Cookie: 'session=user-token' } },
      },
    };

    const res = await app.request(
      '/api/scans',
      authed(cookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetId: id, credentials }),
      }),
    );
    assert.equal(res.status, 201);
    const { id: scanId } = (await res.json()) as { id: string };

    const rows = await handle.db.select().from(schema.scans).where(eq(schema.scans.id, scanId));
    const stored = rows[0]?.credentialsEncrypted;
    assert.ok(typeof stored === 'string' && stored.length > 0, 'credentials should be persisted');
    assert.ok(!stored.includes('sup3r-secret'), 'plaintext must not be present in storage'); // encrypted, not raw
    assert.deepEqual(JSON.parse(cipher.decrypt(stored)), credentials); // round-trips exactly
  });

  test('malformed scan credentials are refused without echoing them (§5)', async () => {
    const app = makeApp(defaultLimits);
    const cookie = await signUp(app, `badcreds-${Date.now()}@example.com`);
    const id = await createTarget(app, cookie, 'badcreds.example.com');
    await handle.db
      .update(schema.targets)
      .set({ authorizationConfirmedAt: new Date() })
      .where(eq(schema.targets.id, id));

    const res = await app.request(
      '/api/scans',
      authed(cookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetId: id, credentials: { jwtSample: 12345 } }), // wrong type
      }),
    );
    assert.equal(res.status, 400);
    const bodyText = await res.text();
    assert.ok(!bodyText.includes('12345'), 'the rejected value must not be reflected'); // §5
  });

  // Authorize a target (DB stamp) and start a scan; returns the scan id. Uses the given app so the
  // injected fake runtime records the start call.
  async function authorizedScan(app: Hono<AppEnv>, cookie: string, host: string): Promise<string> {
    const id = await createTarget(app, cookie, host);
    await handle.db.update(schema.targets).set({ authorizationConfirmedAt: new Date() }).where(eq(schema.targets.id, id));
    const res = await app.request(
      '/api/scans',
      authed(cookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetId: id }),
      }),
    );
    assert.equal(res.status, 201);
    return ((await res.json()) as { id: string }).id;
  }

  test('POST /scans signals the workflow to start', async () => {
    const rt = fakeRuntime();
    const app = makeApp(defaultLimits, noProof, rt.service);
    const cookie = await signUp(app, `start-${Date.now()}@example.com`);
    const scanId = await authorizedScan(app, cookie, 'start.example.com');
    assert.equal(rt.calls.start.length, 1);
    assert.equal(rt.calls.start[0]?.scanId, scanId); // started the exact scan just created
  });

  test('approval gate: an accepted decision maps to 200 with approved/rejected', async () => {
    const h1 = '11111111-1111-4111-8111-111111111111';
    const rt = fakeRuntime({ approval: { kind: 'accepted', approved: [h1], rejected: [] } });
    const app = makeApp(defaultLimits, noProof, rt.service);
    const cookie = await signUp(app, `appr-${Date.now()}@example.com`);
    const scanId = await authorizedScan(app, cookie, 'appr.example.com');

    const res = await app.request(
      `/api/scans/${scanId}/approvals`,
      authed(cookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approvedHypotheses: [h1] }),
      }),
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'accepted', approved: [h1], rejected: [] });
    assert.deepEqual(rt.calls.approvals[0]?.approved, [h1]);
    assert.equal(rt.calls.approvals[0]?.scanId, scanId);
  });

  test('approval gate: not_awaiting → 409, invalid_hypotheses → 400', async () => {
    const stale = makeApp(defaultLimits, noProof, fakeRuntime({ approval: { kind: 'not_awaiting' } }).service);
    const c1 = await signUp(stale, `stale-${Date.now()}@example.com`);
    const s1 = await authorizedScan(stale, c1, 'stale.example.com');
    const r1 = await stale.request(
      `/api/scans/${s1}/approvals`,
      authed(c1, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvedHypotheses: [] }) }),
    );
    assert.equal(r1.status, 409);
    assert.deepEqual(await r1.json(), { error: 'not_awaiting_approval' });

    const bogus = '22222222-2222-4222-8222-222222222222';
    const inv = makeApp(defaultLimits, noProof, fakeRuntime({ approval: { kind: 'invalid_hypotheses', unknown: [bogus] } }).service);
    const c2 = await signUp(inv, `inv-${Date.now()}@example.com`);
    const s2 = await authorizedScan(inv, c2, 'inv.example.com');
    const r2 = await inv.request(
      `/api/scans/${s2}/approvals`,
      authed(c2, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvedHypotheses: [bogus] }) }),
    );
    assert.equal(r2.status, 400);
    assert.deepEqual(await r2.json(), { error: 'invalid_hypotheses', unknown: [bogus] });
  });

  test('approval + cancel are 404 for a non-owner (ADR-19)', async () => {
    const rt = fakeRuntime();
    const app = makeApp(defaultLimits, noProof, rt.service);
    const owner = await signUp(app, `ao-${Date.now()}@example.com`);
    const intruder = await signUp(app, `ai-${Date.now()}@example.com`);
    const scanId = await authorizedScan(app, owner, 'ao.example.com');

    const appr = await app.request(
      `/api/scans/${scanId}/approvals`,
      authed(intruder, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvedHypotheses: [] }) }),
    );
    assert.equal(appr.status, 404);
    const cancel = await app.request(`/api/scans/${scanId}/cancel`, authed(intruder, { method: 'POST' }));
    assert.equal(cancel.status, 404);
    // The intruder's calls never reached the service (blocked at the owner gate).
    assert.equal(rt.calls.approvals.length, 0);
    assert.equal(rt.calls.cancels.length, 0);
  });

  test('cancel maps outcomes: cancelled → 200, not_cancellable → 409', async () => {
    const ok = makeApp(defaultLimits, noProof, fakeRuntime({ cancel: 'cancelled' }).service);
    const c1 = await signUp(ok, `cok-${Date.now()}@example.com`);
    const s1 = await authorizedScan(ok, c1, 'cok.example.com');
    const r1 = await ok.request(`/api/scans/${s1}/cancel`, authed(c1, { method: 'POST' }));
    assert.equal(r1.status, 200);
    assert.deepEqual(await r1.json(), { status: 'cancelled' });

    const no = makeApp(defaultLimits, noProof, fakeRuntime({ cancel: 'not_cancellable' }).service);
    const c2 = await signUp(no, `cno-${Date.now()}@example.com`);
    const s2 = await authorizedScan(no, c2, 'cno.example.com');
    const r2 = await no.request(`/api/scans/${s2}/cancel`, authed(c2, { method: 'POST' }));
    assert.equal(r2.status, 409);
    assert.deepEqual(await r2.json(), { error: 'not_cancellable' });
  });

  test('list endpoints return only the caller`s own rows', async () => {
    const app = makeApp(defaultLimits);
    const cookieA = await signUp(app, `lista-${Date.now()}@example.com`);
    const cookieB = await signUp(app, `listb-${Date.now()}@example.com`);
    const idA = await createTarget(app, cookieA, `list-a-${Date.now()}.example.com`);

    const listA = await app.request('/api/targets', authed(cookieA));
    const targetsA = ((await listA.json()) as { targets: { id: string }[] }).targets;
    assert.ok(targetsA.some((t) => t.id === idA));

    const listB = await app.request('/api/targets', authed(cookieB));
    const targetsB = ((await listB.json()) as { targets: { id: string }[] }).targets;
    assert.ok(!targetsB.some((t) => t.id === idA)); // B never sees A's target
  });

  // The folded-in Unit 1 follow-up: rate-limit counters in Redis (shared across instances, ADR-20).
  // Proves the ioredis→RedisStore adapter works end-to-end. Opt-in via REDIS_URL (needs both a
  // Postgres and a Redis up).
  if (REDIS_URL === undefined) {
    test('rate limit uses the Redis store (skipped — set REDIS_URL)', { skip: true }, () => {});
  } else {
    const redisUrl = REDIS_URL;
    test('per-user rate limit enforced via the Redis store (ADR-20)', async () => {
      const redis = createRedis(redisUrl);
      try {
        // Unique prefix per run so leftover counters from a prior run don't interfere.
        const prefix = `test:rl:${Date.now()}:`;
        const store = (name: string): RedisStore<AppEnv> =>
          new RedisStore<AppEnv>({ client: honoRateLimitClient(redis), prefix: `${prefix}${name}:` });
        const app = createApp({
          auth,
          db: handle.db,
          limits: { ...defaultLimits, max: 2 },
          logger,
          proofPorts: noProof,
          encryptCredentials,
          scanRuntime: noRuntime,
          rateLimitStore: store,
        });
        const cookie = await signUp(app, `redisrl-${Date.now()}@example.com`);
        const id = '00000000-0000-0000-0000-000000000000';
        assert.equal((await app.request(`/api/targets/${id}`, authed(cookie))).status, 404);
        assert.equal((await app.request(`/api/targets/${id}`, authed(cookie))).status, 404);
        assert.equal((await app.request(`/api/targets/${id}`, authed(cookie))).status, 429);
      } finally {
        redis.disconnect();
      }
    });
  }
}
