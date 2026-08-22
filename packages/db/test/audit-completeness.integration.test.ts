import { strict as assert } from 'node:assert';
import { before, test } from 'node:test';

import { createDb, type DbHandle, runMigrations } from '../src/client.ts';
import {
  createScanWithinCap,
  getAuditForScanOwner,
  insertHypotheses,
  recordApprovalDecision,
  requestScanCancel,
  setScanStatus,
} from '../src/index.ts';
import { users } from '../src/schema/auth.ts';
import { targets } from '../src/schema/domain.ts';

// Unit 8 forced safety-audit test: AUDIT COMPLETENESS across a scan's human-action lifecycle (ADR-16
// — every action logged, with the human as actor, at the point it happens). Exercises the real repo
// writes end to end: create → approve/reject → cancel. This closes two gaps found in the audit sweep
// (createScanWithinCap and requestScanCancel previously wrote no audit row). Opt-in via DATABASE_URL.
const DATABASE_URL = process.env.DATABASE_URL;

if (DATABASE_URL === undefined) {
  test('audit completeness integration (skipped — set DATABASE_URL with a running Postgres)', { skip: true }, () => {});
} else {
  runIntegrationTests(DATABASE_URL);
}

function runIntegrationTests(databaseUrl: string): void {
  let handle: DbHandle;
  let ownerId: string;
  let targetId: string;

  before(async () => {
    handle = createDb(databaseUrl);
    await runMigrations(handle);
    const u = (
      await handle.db.insert(users).values({ name: 'A', email: `audit-${Date.now()}@example.com` }).returning()
    )[0]!;
    ownerId = u.id;
    targetId = (
      await handle.db.insert(targets).values({ ownerId, url: 'https://app.example.com', scopeRules: {} }).returning()
    )[0]!.id;
  });

  test('every human action across a scan lifecycle is audited with the human as actor', async () => {
    // 1. Scan creation is audited (scan.created, actor = the human owner).
    const scan = await createScanWithinCap(handle.db, { ownerId, targetId, cap: 10 });
    assert.ok(scan, 'scan should be created within cap');
    const scanId = scan.id;

    let audit = await getAuditForScanOwner(handle.db, ownerId, scanId);
    const created = audit.find((a) => a.action === 'scan.created');
    assert.ok(created, 'scan.created must be audited');
    assert.equal(created.actor, ownerId);
    assert.equal(created.detail, `target=${targetId}`);

    // 2. Move to the approval gate with two pending hypotheses, then record a human decision.
    await setScanStatus(handle.db, scanId, 'awaiting_approval');
    const hyps = await insertHypotheses(handle.db, [
      { scanId, vulnClass: 'jwt', endpoint: 'https://app.example.com/a', rationale: 'r', fingerprint: `af1-${scanId}` },
      { scanId, vulnClass: 'idor', endpoint: 'https://app.example.com/b', rationale: 'r', fingerprint: `af2-${scanId}` },
    ]);
    const [h1, h2] = [hyps[0]!.id, hyps[1]!.id];
    const decision = await recordApprovalDecision(handle.db, { ownerId, scanId, approvedHypotheses: [h1] });
    assert.equal(decision.kind, 'accepted');

    // 3. The scan is now 'testing' (active); the human cancels it — cancel is audited too.
    const cancel = await requestScanCancel(handle.db, ownerId, scanId);
    assert.equal(cancel, 'cancelled');

    // The full trail is complete: every human action left an owner-attributed audit row.
    audit = await getAuditForScanOwner(handle.db, ownerId, scanId);
    const byAction = new Map(audit.map((a) => [a.action, a] as const));
    for (const action of ['scan.created', 'hypothesis.approved', 'hypothesis.rejected', 'scan.cancelled']) {
      const row = byAction.get(action);
      assert.ok(row, `missing audit row for ${action}`);
      assert.equal(row.actor, ownerId, `${action} must be attributed to the human owner`);
    }
    assert.equal(byAction.get('hypothesis.approved')!.detail, `hypothesis=${h1}`);
    assert.equal(byAction.get('hypothesis.rejected')!.detail, `hypothesis=${h2}`);
    assert.equal(byAction.get('scan.cancelled')!.detail, 'from=testing');
  });

  test('scan.cancelled is not written when there is nothing to cancel (no phantom audit)', async () => {
    const scan = await createScanWithinCap(handle.db, { ownerId, targetId, cap: 10 });
    assert.ok(scan);
    // Drive it terminal without a human cancel.
    await setScanStatus(handle.db, scan.id, 'completed');
    const outcome = await requestScanCancel(handle.db, ownerId, scan.id);
    assert.equal(outcome, 'not_cancellable');

    const audit = await getAuditForScanOwner(handle.db, ownerId, scan.id);
    assert.ok(!audit.some((a) => a.action === 'scan.cancelled'), 'a refused cancel must not write an audit row');
    // The creation audit is still present — completeness cuts both ways.
    assert.ok(audit.some((a) => a.action === 'scan.created'));
  });
}
