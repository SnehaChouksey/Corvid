import type { ScanStatus } from '@corvid/tool-contracts';
import { and, desc, eq } from 'drizzle-orm';

import type { Database } from '../client.ts';
import { scans } from '../schema/domain.ts';

export type ScanRow = typeof scans.$inferSelect;
export type NewScan = typeof scans.$inferInsert;

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
  const active: readonly ScanStatus[] = [
    'authorizing',
    'crawling',
    'hypothesizing',
    'awaiting_approval',
    'testing',
    'reporting',
  ];
  const rows = await db.select({ status: scans.status }).from(scans).where(eq(scans.ownerId, ownerId));
  return rows.filter((r) => active.includes(r.status)).length;
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
