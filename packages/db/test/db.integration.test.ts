import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';

import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { createDb, type DbHandle } from '../src/client.ts';
import {
  appendAudit,
  createScan,
  createTarget,
  getAuditForScanOwner,
  getTargetForOwner,
  listTargetsForOwner,
} from '../src/index.ts';
import { users } from '../src/schema/auth.ts';
import { auditLog } from '../src/schema/domain.ts';

// Integration test against a real Postgres (docker compose service). The whole point of the data
// layer is tenant isolation and an append-only audit log — both are DB-level guarantees, so both
// must be proven against a DB, not a mock (CODING_STANDARDS §7).

// Integration tests need a real Postgres, so they're opt-in: set DATABASE_URL (with the docker
// compose service up) to run them. `pnpm turbo run test` on a machine without a DB skips cleanly
// rather than failing on an unrelated package.
const DATABASE_URL = process.env.DATABASE_URL;
const migrationsFolder = new URL('../migrations', import.meta.url).pathname;

if (DATABASE_URL === undefined) {
  test('db integration (skipped — set DATABASE_URL with a running Postgres to run)', { skip: true }, () => {});
} else {
  runIntegrationTests(DATABASE_URL);
}

function runIntegrationTests(databaseUrl: string): void {
  let handle: DbHandle;
  let userA: string;
  let userB: string;

  before(async () => {
    handle = createDb(databaseUrl);
  await migrate(handle.db, { migrationsFolder });
  // Clean slate; cascades clear dependent rows.
  await handle.db.execute(sql`TRUNCATE TABLE users RESTART IDENTITY CASCADE`);

  const inserted = await handle.db
    .insert(users)
    .values([
      { name: 'A', email: `a-${Date.now()}@example.com` },
      { name: 'B', email: `b-${Date.now()}@example.com` },
    ])
    .returning({ id: users.id });
  userA = inserted[0]!.id;
  userB = inserted[1]!.id;
});

after(async () => {
  await handle.pool.end();
});

test('a target is only visible to its owner — a non-owner gets undefined (404, not 403)', async () => {
  const target = await createTarget(handle.db, {
    ownerId: userA,
    url: 'https://app.example.com',
    scopeRules: { hosts: ['app.example.com'] },
  });

  assert.equal((await getTargetForOwner(handle.db, userA, target.id))?.id, target.id);
  assert.equal(await getTargetForOwner(handle.db, userB, target.id), undefined); // no cross-tenant read
  assert.equal((await listTargetsForOwner(handle.db, userB)).length, 0);
});

test('audit records are readable only by the owner of their scan', async () => {
  const target = await createTarget(handle.db, {
    ownerId: userA,
    url: 'https://api.example.com',
    scopeRules: { hosts: ['api.example.com'] },
  });
  const scan = await createScan(handle.db, {
    ownerId: userA,
    targetId: target.id,
    status: 'authorizing',
  });
  await appendAudit(handle.db, { scanId: scan.id, action: 'scan.created', actor: userA });

  assert.equal((await getAuditForScanOwner(handle.db, userA, scan.id)).length, 1);
  assert.equal((await getAuditForScanOwner(handle.db, userB, scan.id)).length, 0); // isolated
});

test('the audit log is structurally append-only: UPDATE and DELETE are no-ops', async () => {
  const target = await createTarget(handle.db, {
    ownerId: userA,
    url: 'https://x.example.com',
    scopeRules: { hosts: ['x.example.com'] },
  });
  const scan = await createScan(handle.db, {
    ownerId: userA,
    targetId: target.id,
    status: 'authorizing',
  });
  await appendAudit(handle.db, { scanId: scan.id, action: 'payload.sent', actor: 'agent', detail: 'ok' });

  // A rogue UPDATE and DELETE must both leave the row untouched (DB rule rewrites them to nothing).
  await handle.db.update(auditLog).set({ action: 'tampered' }).where(eq(auditLog.scanId, scan.id));
  await handle.db.delete(auditLog).where(eq(auditLog.scanId, scan.id));

  const rows = await getAuditForScanOwner(handle.db, userA, scan.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.action, 'payload.sent'); // unchanged despite the UPDATE attempt
  });
}
