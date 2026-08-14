import { strict as assert } from 'node:assert';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { and, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { createDb, type DbHandle } from '../src/client.ts';
import { getAuditForScanOwner, insertHypotheses, listHypothesesForScan, recordApprovalDecision } from '../src/index.ts';
import { users } from '../src/schema/auth.ts';
import { hypotheses, scans, targets } from '../src/schema/domain.ts';

// The approval decision is the safety-critical write that authorizes active testing (invariant #1),
// and its atomicity/guard are DB-level guarantees (advisory lock + status guard + owner scope), so
// they must be proven against a real Postgres, not a mock (§7). Opt-in via DATABASE_URL.
const DATABASE_URL = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

if (DATABASE_URL === undefined) {
  test('approvals integration (skipped — set DATABASE_URL with a running Postgres)', { skip: true }, () => {});
} else {
  runIntegrationTests(DATABASE_URL);
}

function runIntegrationTests(databaseUrl: string): void {
  let handle: DbHandle;
  let ownerId: string;
  let targetId: string;

  before(async () => {
    handle = createDb(databaseUrl);
    await migrate(handle.db, { migrationsFolder });
    const u = (await handle.db.insert(users).values({ name: 'A', email: `appr-${Date.now()}@example.com` }).returning())[0]!;
    ownerId = u.id;
    targetId = (
      await handle.db.insert(targets).values({ ownerId, url: 'https://app.example.com', scopeRules: {} }).returning()
    )[0]!.id;
  });

  // Create a fresh scan at the approval gate with two pending hypotheses; return ids.
  async function gatedScan(): Promise<{ scanId: string; h1: string; h2: string }> {
    const scanId = (
      await handle.db.insert(scans).values({ ownerId, targetId, status: 'awaiting_approval' }).returning()
    )[0]!.id;
    const inserted = await insertHypotheses(handle.db, [
      { scanId, vulnClass: 'jwt', endpoint: 'https://app.example.com/a', rationale: 'r', fingerprint: `f1-${scanId}` },
      { scanId, vulnClass: 'idor', endpoint: 'https://app.example.com/b', rationale: 'r', fingerprint: `f2-${scanId}` },
    ]);
    return { scanId, h1: inserted[0]!.id, h2: inserted[1]!.id };
  }

  test('accepts a subset: approves one, rejects the rest, moves off the gate, audits the human', async () => {
    const { scanId, h1, h2 } = await gatedScan();
    const outcome = await recordApprovalDecision(handle.db, { ownerId, scanId, approvedHypotheses: [h1] });
    assert.deepEqual(outcome, { kind: 'accepted', approved: [h1], rejected: [h2] });

    const hyps = await listHypothesesForScan(handle.db, scanId);
    assert.equal(hyps.find((h) => h.id === h1)?.status, 'approved');
    assert.equal(hyps.find((h) => h.id === h2)?.status, 'rejected');
    const scan = (await handle.db.select().from(scans).where(eq(scans.id, scanId)))[0];
    assert.equal(scan?.status, 'testing'); // left the gate

    // Both decisions audited with the human as actor.
    const audit = await getAuditForScanOwner(handle.db, ownerId, scanId);
    assert.ok(audit.some((a) => a.action === 'hypothesis.approved' && a.actor === ownerId && a.detail === `hypothesis=${h1}`));
    assert.ok(audit.some((a) => a.action === 'hypothesis.rejected' && a.actor === ownerId && a.detail === `hypothesis=${h2}`));
  });

  test('approve nothing is valid: all pending become rejected, scan proceeds', async () => {
    const { scanId, h1, h2 } = await gatedScan();
    const outcome = await recordApprovalDecision(handle.db, { ownerId, scanId, approvedHypotheses: [] });
    assert.equal(outcome.kind, 'accepted');
    const hyps = await listHypothesesForScan(handle.db, scanId);
    assert.ok([h1, h2].every((id) => hyps.find((h) => h.id === id)?.status === 'rejected'));
  });

  test('a foreign/unknown hypothesis id is refused and NOTHING is mutated (invariant #1)', async () => {
    const { scanId, h1, h2 } = await gatedScan();
    const bogus = '00000000-0000-0000-0000-000000000000';
    const outcome = await recordApprovalDecision(handle.db, { ownerId, scanId, approvedHypotheses: [h1, bogus] });
    assert.deepEqual(outcome, { kind: 'invalid_hypotheses', unknown: [bogus] });
    // The transaction rolled back: both hypotheses are still pending, the scan still at the gate.
    const hyps = await listHypothesesForScan(handle.db, scanId);
    assert.ok([h1, h2].every((id) => hyps.find((h) => h.id === id)?.status === 'pending'));
    const scan = (await handle.db.select().from(scans).where(eq(scans.id, scanId)))[0];
    assert.equal(scan?.status, 'awaiting_approval');
  });

  test('a duplicate submit after the gate is closed is rejected (not_awaiting)', async () => {
    const { scanId, h1 } = await gatedScan();
    assert.equal((await recordApprovalDecision(handle.db, { ownerId, scanId, approvedHypotheses: [h1] })).kind, 'accepted');
    // Second submit: the scan is now 'testing', so the guard rejects it — no re-approval.
    assert.equal(
      (await recordApprovalDecision(handle.db, { ownerId, scanId, approvedHypotheses: [h1] })).kind,
      'not_awaiting',
    );
  });

  test('a non-owner cannot record a decision (owner-scoped)', async () => {
    const { scanId, h1 } = await gatedScan();
    const other = (await handle.db.insert(users).values({ name: 'X', email: `x-${Date.now()}@example.com` }).returning())[0]!.id;
    const outcome = await recordApprovalDecision(handle.db, { ownerId: other, scanId, approvedHypotheses: [h1] });
    assert.equal(outcome.kind, 'not_awaiting'); // not visible to a non-owner → treated as not-at-gate
    // Untouched.
    const stillPending = await handle.db
      .select()
      .from(hypotheses)
      .where(and(eq(hypotheses.scanId, scanId), eq(hypotheses.id, h1)));
    assert.equal(stillPending[0]?.status, 'pending');
  });
}
