import { strict as assert } from 'node:assert';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { createDb, type DbHandle } from '../src/client.ts';
import { insertHypotheses, listHypothesesForScan } from '../src/index.ts';
import { users } from '../src/schema/auth.ts';
import { scans, targets } from '../src/schema/domain.ts';

// Integration test against a real Postgres (docker compose). Per-scan dedup is a DB-level guarantee
// (the unique (scan_id, fingerprint) index + onConflictDoNothing), so replay-safety must be proven
// against a DB, not a mock (§7). Opt-in via DATABASE_URL; `fileURLToPath` for Windows path safety.
const DATABASE_URL = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

if (DATABASE_URL === undefined) {
  test('hypotheses integration (skipped — set DATABASE_URL with a running Postgres to run)', { skip: true }, () => {});
} else {
  runIntegrationTests(DATABASE_URL);
}

function runIntegrationTests(databaseUrl: string): void {
  let handle: DbHandle;
  let scanId: string;

  before(async () => {
    handle = createDb(databaseUrl);
    await migrate(handle.db, { migrationsFolder });
    const uRows = await handle.db
      .insert(users)
      .values({ name: 'S', email: `hypo-${Date.now()}@example.com` })
      .returning();
    const u = uRows[0];
    assert.ok(u);
    const tRows = await handle.db
      .insert(targets)
      .values({ ownerId: u.id, url: 'https://app.example.com', scopeRules: {} })
      .returning();
    const t = tRows[0];
    assert.ok(t);
    const sRows = await handle.db
      .insert(scans)
      .values({ ownerId: u.id, targetId: t.id, status: 'hypothesizing' })
      .returning();
    const s = sRows[0];
    assert.ok(s);
    scanId = s.id;
  });

  test('inserts pending hypotheses and round-trips the plan jsonb', async () => {
    const inserted = await insertHypotheses(handle.db, [
      {
        scanId,
        vulnClass: 'idor',
        endpoint: 'GET https://app.example.com/api/orders/42',
        rationale: 'Sequential order id under an authenticated session.',
        fingerprint: 'fp-idor-orders',
        plan: { method: 'GET', param: { name: 'id', location: 'path' }, payloadFamily: 'cross-session-read' },
      },
    ]);
    assert.equal(inserted.length, 1);
    const row = inserted[0];
    assert.ok(row);
    assert.equal(row.status, 'pending');
    assert.equal(row.plan?.method, 'GET');
    assert.equal(row.plan?.payloadFamily, 'cross-session-read');
  });

  test('re-inserting the same fingerprint dedups (replay-safe upsert returns no new rows)', async () => {
    const fingerprint = 'fp-jwt-alg-none';
    const first = await insertHypotheses(handle.db, [
      { scanId, vulnClass: 'jwt', endpoint: 'https://app.example.com/api/me', rationale: 'JWT accepted.', fingerprint },
    ]);
    assert.equal(first.length, 1);

    // A replay of the same batch (e.g. the node re-runs on resume) inserts nothing new.
    const replay = await insertHypotheses(handle.db, [
      { scanId, vulnClass: 'jwt', endpoint: 'https://app.example.com/api/me', rationale: 'JWT accepted.', fingerprint },
    ]);
    assert.equal(replay.length, 0);

    const all = await listHypothesesForScan(handle.db, scanId);
    assert.equal(all.filter((h) => h.fingerprint === fingerprint).length, 1);
  });

  test('the same fingerprint in a different scan is not deduped (dedup is per scan)', async () => {
    const uRows = await handle.db
      .insert(users)
      .values({ name: 'T', email: `hypo2-${Date.now()}@example.com` })
      .returning();
    const u = uRows[0];
    assert.ok(u);
    const tRows = await handle.db
      .insert(targets)
      .values({ ownerId: u.id, url: 'https://b.example.com', scopeRules: {} })
      .returning();
    const t = tRows[0];
    assert.ok(t);
    const sRows = await handle.db
      .insert(scans)
      .values({ ownerId: u.id, targetId: t.id, status: 'hypothesizing' })
      .returning();
    const s = sRows[0];
    assert.ok(s);

    const inserted = await insertHypotheses(handle.db, [
      { scanId: s.id, vulnClass: 'jwt', endpoint: 'https://b.example.com/api/me', rationale: 'x', fingerprint: 'fp-jwt-alg-none' },
    ]);
    assert.equal(inserted.length, 1); // same fingerprint, different scan → inserted
  });
}
