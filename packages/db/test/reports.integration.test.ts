import { strict as assert } from 'node:assert';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Report } from '@corvid/tool-contracts';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { createDb, type DbHandle } from '../src/client.ts';
import {
  getReportForScanOwner,
  getReportPdfForScanOwner,
  getScanReportData,
  insertFinding,
  insertHypotheses,
  upsertReport,
} from '../src/index.ts';
import { users } from '../src/schema/auth.ts';
import { scans, targets } from '../src/schema/domain.ts';

// Integration test against a real Postgres. The report row is owner-scoped and its data source is a
// verified-only projection — both are DB-level guarantees, proven against a DB not a mock. Opt-in via
// DATABASE_URL.
const DATABASE_URL = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

function report(scanId: string): Report {
  return {
    scanId,
    generatedAt: new Date().toISOString(),
    target: { url: 'https://app.example.com' },
    summary: 'Two verified findings.',
    clean: false,
    findings: [],
  };
}

if (DATABASE_URL === undefined) {
  test('reports integration (skipped — set DATABASE_URL with a running Postgres to run)', { skip: true }, () => {});
} else {
  runIntegrationTests(DATABASE_URL);
}

function runIntegrationTests(databaseUrl: string): void {
  let handle: DbHandle;
  let ownerId: string;
  let otherId: string;
  let scanId: string;

  before(async () => {
    handle = createDb(databaseUrl);
    await migrate(handle.db, { migrationsFolder });
    const stamp = Date.now();
    const [owner] = await handle.db
      .insert(users)
      .values({ name: 'O', email: `rep-owner-${stamp}@example.com` })
      .returning();
    const [other] = await handle.db
      .insert(users)
      .values({ name: 'X', email: `rep-other-${stamp}@example.com` })
      .returning();
    assert.ok(owner && other);
    ownerId = owner.id;
    otherId = other.id;
    const [t] = await handle.db
      .insert(targets)
      .values({ ownerId, url: 'https://app.example.com', scopeRules: {} })
      .returning();
    assert.ok(t);
    const [s] = await handle.db
      .insert(scans)
      .values({ ownerId, targetId: t.id, status: 'reporting' })
      .returning();
    assert.ok(s);
    scanId = s.id;
  });

  test('getScanReportData projects verified findings + endpoint, never rationale', async () => {
    const [h] = await insertHypotheses(handle.db, [
      {
        scanId,
        vulnClass: 'injection',
        endpoint: 'POST https://app.example.com/api/search',
        rationale: 'SECRET REASONING — must never appear in report data',
        fingerprint: 'fp-inj-1',
      },
    ]);
    assert.ok(h);
    await insertFinding(handle.db, {
      hypothesisId: h.id,
      vulnClass: 'injection',
      payload: 'sql-error',
      proof: 'Dose-response time delay observed.',
      severity: '9.8 CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
    });

    const data = await getScanReportData(handle.db, scanId);
    assert.ok(data);
    assert.equal(data.targetUrl, 'https://app.example.com');
    assert.equal(data.findings.length, 1);
    const f = data.findings[0]!;
    assert.equal(f.endpoint, 'POST https://app.example.com/api/search');
    assert.equal(f.vulnClass, 'injection');
    // The projection shape has no rationale key at all — structurally reasoning-free.
    assert.equal('rationale' in f, false);
    assert.equal(JSON.stringify(data).includes('SECRET REASONING'), false);
  });

  test('upsertReport is idempotent per scan and round-trips content + pdf', async () => {
    await upsertReport(handle.db, { scanId, content: report(scanId) });
    const pdf = Buffer.from('%PDF-1.4 fake', 'utf8');
    await upsertReport(handle.db, { scanId, content: { ...report(scanId), summary: 'updated' }, pdf });

    const stored = await getReportForScanOwner(handle.db, ownerId, scanId);
    assert.ok(stored);
    assert.equal(stored.content.summary, 'updated'); // last write wins, one row
    const roundTripped = await getReportPdfForScanOwner(handle.db, ownerId, scanId);
    assert.ok(roundTripped);
    assert.equal(roundTripped.toString('utf8'), '%PDF-1.4 fake');
  });

  test('a non-owner reads nothing (404-not-403 at the boundary)', async () => {
    assert.equal(await getReportForScanOwner(handle.db, otherId, scanId), undefined);
    assert.equal(await getReportPdfForScanOwner(handle.db, otherId, scanId), undefined);
  });
}
