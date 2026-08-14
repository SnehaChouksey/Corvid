import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { createAuth, type Auth } from '@corvid/auth';
import { createDb, type DbHandle, runMigrations, schema } from '@corvid/db';
import { createLogger } from '@corvid/logger';
import type { ProofPorts } from '@corvid/proof-of-control';
import { createRedis, honoRateLimitClient } from '@corvid/redis';
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
  const makeApp = (limits: AppLimits, proofPorts: ProofPorts = noProof): Hono<AppEnv> =>
    createApp({ auth, db: handle.db, limits, logger, proofPorts });
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
