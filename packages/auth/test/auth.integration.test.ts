import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { createDb, type DbHandle, runMigrations, schema } from '@corvid/db';
import { eq } from 'drizzle-orm';

import { createAuth, resolveUserId, type Auth } from '../src/index.ts';

// Better Auth wiring is only meaningfully testable against a real DB (adapter + schema + id
// strategy). Opt-in via DATABASE_URL, same as the db package. The highest-risk thing this proves:
// sign-up succeeds AND the generated id is a uuid (DB-generated, not Better Auth's string id) —
// if that were wrong the insert into the uuid PK column would throw.

const DATABASE_URL = process.env.DATABASE_URL;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

if (DATABASE_URL === undefined) {
  test('auth integration (skipped — set DATABASE_URL with a running Postgres to run)', { skip: true }, () => {});
} else {
  runIntegrationTests(DATABASE_URL);
}

function runIntegrationTests(databaseUrl: string): void {
  let handle: DbHandle;
  let auth: Auth;

  before(async () => {
    handle = createDb(databaseUrl);
    await runMigrations(handle);
    // No TRUNCATE (audit log is immutable); tests use unique emails so prior rows don't interfere.
    auth = createAuth({
      database: handle.db,
      secret: 'test-secret-not-a-real-key-0123456789',
      baseURL: 'http://localhost:3000',
    });
  });

  after(async () => {
    await handle.pool.end();
  });

  test('sign-up creates a user with a DB-generated uuid id (ADR-19, 02 §5)', async () => {
    const email = `signup-${Date.now()}@example.com`;
    const result = await auth.api.signUpEmail({
      body: { email, password: 'a-strong-password', name: 'Analyst' },
    });

    assert.match(result.user.id, UUID_RE);
    assert.equal(result.user.email, email);

    const rows = await handle.db.select().from(schema.users).where(eq(schema.users.id, result.user.id));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.email, email);
  });

  test('resolveUserId returns null for an unauthenticated request', async () => {
    assert.equal(await resolveUserId(auth, new Headers()), null);
  });
}
