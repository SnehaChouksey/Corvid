import type { ScanStatus } from '@corvid/tool-contracts';
import { and, desc, eq, sql } from 'drizzle-orm';

import type { Database } from '../client.ts';
import { scans, targets } from '../schema/domain.ts';
import type { TargetRow } from './targets.ts';

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

/**
 * Load the target a scan belongs to. Used by trusted system actors (the crawler/tool servers) that
 * act on a scan id handed to them by the orchestrator — the authorization decision is then made on
 * the returned target's `authorizationConfirmedAt` + `scopeRules`, NOT on a caller-supplied value.
 * Returns undefined if the scan does not exist.
 */
export async function getTargetForScan(
  db: Database,
  scanId: string,
): Promise<TargetRow | undefined> {
  const rows = await db
    .select({ target: targets })
    .from(scans)
    .innerJoin(targets, eq(scans.targetId, targets.id))
    .where(eq(scans.id, scanId))
    .limit(1);
  return rows[0]?.target;
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
  params: {
    readonly ownerId: string;
    readonly targetId: string;
    readonly cap: number;
    /** Opaque ciphertext of the scan's `ScanCredentials` (D-1), or omitted for none. */
    readonly credentialsEncrypted?: string;
  },
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
      .values({
        ownerId: params.ownerId,
        targetId: params.targetId,
        status: 'authorizing',
        ...(params.credentialsEncrypted !== undefined
          ? { credentialsEncrypted: params.credentialsEncrypted }
          : {}),
      })
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
