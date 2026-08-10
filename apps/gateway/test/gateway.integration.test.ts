import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { createAuth, type Auth } from '@corvid/auth';
import { createDb, type DbHandle, runMigrations, schema } from '@corvid/db';
import { createLogger } from '@corvid/logger';
import { eq, sql } from 'drizzle-orm';
import type { Hono } from 'hono';

import { type AppEnv, type AppLimits, createApp } from '../src/app.ts';

// End-to-end gateway behavior over real HTTP (via app.request) against a real Postgres + Better
// Auth. Proves the Unit 1 safety DoD lines that only exist at the HTTP boundary: cross-tenant 404,
// refuse-unauthorized scan start, and abuse controls firing with typed refusals. Opt-in via
// DATABASE_URL.

const DATABASE_URL = process.env.DATABASE_URL;
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
    await handle.db.execute(sql`TRUNCATE TABLE users RESTART IDENTITY CASCADE`);
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

  const makeApp = (limits: AppLimits): Hono<AppEnv> => createApp({ auth, db: handle.db, limits, logger });
  const defaultLimits: AppLimits = { windowMs: 60_000, max: 100, concurrentScanCap: 5 };

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
}
