import { and, desc, eq } from 'drizzle-orm';

import type { Database } from '../client.ts';
import { targets } from '../schema/domain.ts';

export type TargetRow = typeof targets.$inferSelect;
export type NewTarget = typeof targets.$inferInsert;

// Every read is scoped by owner_id in the WHERE clause — tenant isolation lives in the data layer,
// never in a caller/UI check (ADR-19, CODING_STANDARDS §5). A not-owned target returns `undefined`,
// which the gateway renders as 404 (not 403) so existence isn't leaked cross-tenant.

export async function getTargetForOwner(
  db: Database,
  ownerId: string,
  targetId: string,
): Promise<TargetRow | undefined> {
  const rows = await db
    .select()
    .from(targets)
    .where(and(eq(targets.id, targetId), eq(targets.ownerId, ownerId)))
    .limit(1);
  return rows[0];
}

export async function listTargetsForOwner(db: Database, ownerId: string): Promise<TargetRow[]> {
  return db
    .select()
    .from(targets)
    .where(eq(targets.ownerId, ownerId))
    .orderBy(desc(targets.createdAt));
}

export async function createTarget(db: Database, target: NewTarget): Promise<TargetRow> {
  const rows = await db.insert(targets).values(target).returning();
  const row = rows[0];
  if (row === undefined) {
    // insert...returning always yields the row; a missing row means a driver/contract break.
    throw new Error('createTarget: insert returned no row');
  }
  return row;
}
