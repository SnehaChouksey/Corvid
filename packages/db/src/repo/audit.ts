import { and, asc, eq } from 'drizzle-orm';

import type { Database } from '../client.ts';
import { auditLog, scans } from '../schema/domain.ts';

export type AuditRow = typeof auditLog.$inferSelect;

export interface AuditEntry {
  readonly scanId?: string;
  readonly action: string;
  /** Acting identity: a `users.id` for a human action, or an agent/system actor label. */
  readonly actor: string;
  readonly detail?: string;
}

// Insert + read only, by design — the audit log is append-only (ADR-16), enforced structurally by a
// DB rule (see migrations) as well as by the absence of any update/delete function here. `detail`
// carries safe metadata only, never a secret or raw target body (CODING_STANDARDS §5).
export async function appendAudit(db: Database, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    action: entry.action,
    actor: entry.actor,
    ...(entry.scanId !== undefined ? { scanId: entry.scanId } : {}),
    ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
  });
}

/**
 * The per-scan audit trail, owner-scoped via a join to `scans.owner_id`: a user can only read audit
 * records for a scan they own. Returns an empty list for a scan the caller doesn't own (no leak).
 */
export async function getAuditForScanOwner(
  db: Database,
  ownerId: string,
  scanId: string,
): Promise<AuditRow[]> {
  const rows = await db
    .select({ audit: auditLog })
    .from(auditLog)
    .innerJoin(scans, eq(auditLog.scanId, scans.id))
    .where(and(eq(auditLog.scanId, scanId), eq(scans.ownerId, ownerId)))
    .orderBy(asc(auditLog.timestamp));
  return rows.map((r) => r.audit);
}
