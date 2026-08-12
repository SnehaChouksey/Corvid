import { strict as assert } from 'node:assert';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { createDb, type DbHandle } from '../src/client.ts';
import { recordLlmCall, sumDailyLlmSpend, utcDayStart } from '../src/index.ts';
import { users } from '../src/schema/auth.ts';
import { scans, targets } from '../src/schema/domain.ts';

// Integration test against a real Postgres (docker compose). The daily rollup is a DB-level guarantee
// (a single filtered aggregate over the ledger), so it must be proven against a DB, not a mock (§7).
// Opt-in: set DATABASE_URL to run; skips cleanly otherwise. `fileURLToPath` (not `.pathname`) so the
// migrations path resolves on Windows too.
const DATABASE_URL = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

if (DATABASE_URL === undefined) {
  test('llm_calls integration (skipped — set DATABASE_URL with a running Postgres to run)', { skip: true }, () => {});
} else {
  runIntegrationTests(DATABASE_URL);
}

function runIntegrationTests(databaseUrl: string): void {
  let handle: DbHandle;
  let userId: string;
  let scanId: string;

  async function seedScan(email: string): Promise<{ userId: string; scanId: string }> {
    const uRows = await handle.db.insert(users).values({ name: 'S', email }).returning();
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
    return { userId: u.id, scanId: s.id };
  }

  before(async () => {
    handle = createDb(databaseUrl);
    await migrate(handle.db, { migrationsFolder });
    const seeded = await seedScan(`llm-${Date.now()}@example.com`);
    userId = seeded.userId;
    scanId = seeded.scanId;
  });

  test('records a call and sums it into the daily rollup; a null cost contributes 0', async () => {
    await recordLlmCall(handle.db, {
      scanId,
      userId,
      purpose: 'hypothesize',
      model: 'google/gemini-2.5-flash',
      costCredits: 0.0004,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      isByok: false,
    });
    await recordLlmCall(handle.db, {
      scanId,
      userId,
      purpose: 'hypothesize',
      model: 'google/gemini-2.5-flash',
      costCredits: null, // e.g. BYOK — must not break the sum
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      isByok: true,
    });

    const spend = await sumDailyLlmSpend(handle.db, { userId, since: utcDayStart(new Date()) });
    assert.ok(Math.abs(spend.userSpentCredits - 0.0004) < 1e-9);
    assert.ok(spend.globalSpentCredits >= 0.0004);
  });

  test("another user's spend counts toward global but not this user's per-user total", async () => {
    const other = await seedScan(`llm-other-${Date.now()}@example.com`);
    await recordLlmCall(handle.db, {
      scanId: other.scanId,
      userId: other.userId,
      purpose: 'report',
      model: 'google/gemini-2.5-flash',
      costCredits: 2,
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      isByok: false,
    });

    const spend = await sumDailyLlmSpend(handle.db, { userId, since: utcDayStart(new Date()) });
    assert.ok(spend.userSpentCredits < 1); // unchanged by the other user's spend
    assert.ok(spend.globalSpentCredits >= 2); // global includes it
  });
}
