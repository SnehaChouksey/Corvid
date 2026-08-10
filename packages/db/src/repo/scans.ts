import type { ScanStatus } from '@corvid/tool-contracts';
import { and, desc, eq, sql } from 'drizzle-orm';

import type { Database } from '../client.ts';
import { scans } from '../schema/domain.ts';

export type ScanRow = typeof scans.$inferSelect;
export type NewScan = typeof scans.$inferInsert;

// Non-terminal scan states — the ones that count toward the per-user concurrent-scan cap (ADR-20).
const ACTIVE_STATES: readonly ScanStatus[] = [
  'authorizing',
  'crawling',
  'hypothesizing',
  'awaiting_approval',
  'testing',
  'reporting',
];

export async function getScanForOwner(
  db: Database,
  ownerId: string,
  scanId: string,
): Promise<ScanRow | undefined> {
  const rows = await db
    .select()
    .from(scans)
    .where(and(eq(scans.id, scanId), eq(scans.ownerId, ownerId)))
    .limit(1);
  return rows[0];
}

export async function listScansForOwner(db: Database, ownerId: string): Promise<ScanRow[]> {
  return db.select().from(scans).where(eq(scans.ownerId, ownerId)).orderBy(desc(scans.createdAt));
}

export async function createScan(db: Database, scan: NewScan): Promise<ScanRow> {
  const rows = await db.insert(scans).values(scan).returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error('createScan: insert returned no row');
  }
  return row;
}

/**
 * Count a user's scans currently in an active (not terminal) state — the input to the per-user
 * concurrent-scan cap checked at workflow start (ADR-20). Terminal states are excluded.
 */
export async function countActiveScansForOwner(db: Database, ownerId: string): Promise<number> {
  const rows = await db.select({ status: scans.status }).from(scans).where(eq(scans.ownerId, ownerId));
  return rows.filter((r) => ACTIVE_STATES.includes(r.status)).length;
}

/**
 * Atomically enforce the per-user concurrent-scan cap (ADR-20) and create the scan. The count and
 * insert run in one transaction behind a per-owner advisory lock, so N parallel requests can't all
 * read an under-cap count and all insert (a TOCTOU that would fail OPEN — the opposite of what an
 * abuse control must do). Returns the created scan, or `null` if the cap is already reached.
 */
export async function createScanWithinCap(
  db: Database,
  params: { readonly ownerId: string; readonly targetId: string; readonly cap: number },
): Promise<ScanRow | null> {
  return db.transaction(async (tx) => {
    // Serialize concurrent scan-creation per owner for the duration of the transaction.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${params.ownerId}))`);
    const rows = await tx.select({ status: scans.status }).from(scans).where(eq(scans.ownerId, params.ownerId));
    const active = rows.filter((r) => ACTIVE_STATES.includes(r.status)).length;
    if (active >= params.cap) {
      return null;
    }
    const inserted = await tx
      .insert(scans)
      .values({ ownerId: params.ownerId, targetId: params.targetId, status: 'authorizing' })
      .returning();
    return inserted[0] ?? null;
  });
}

/** Owner-scoped status transition; returns the updated row, or undefined if not owned. */
export async function updateScanStatusForOwner(
  db: Database,
  ownerId: string,
  scanId: string,
  status: ScanStatus,
): Promise<ScanRow | undefined> {
  const rows = await db
    .update(scans)
    .set({ status })
    .where(and(eq(scans.id, scanId), eq(scans.ownerId, ownerId)))
    .returning();
  return rows[0];
}
