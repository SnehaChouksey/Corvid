import type { ApprovalOutcome } from '@corvid/tool-contracts';
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { Database } from '../client.ts';
import { auditLog, hypotheses, scans } from '../schema/domain.ts';

// Recording a human approval decision at the gate (Flow D, `01` §6) — the safety-critical write that
// authorizes active testing. Done in ONE advisory-locked transaction so it is atomic and race-free:
// two concurrent submits for the same scan can't both pass the guard and double-write (the second
// finds status no longer 'awaiting_approval'). This is a money-path (CODING_STANDARDS §10) — the set
// persisted here is exactly what the graph will test, and the graph's verify node re-filters to it as
// defense in depth (invariant #1).

export async function recordApprovalDecision(
  db: Database,
  params: {
    readonly ownerId: string;
    readonly scanId: string;
    /** Hypotheses the human approved. Empty = approve nothing (valid: all pending → rejected). */
    readonly approvedHypotheses: readonly string[];
  },
): Promise<ApprovalOutcome> {
  return db.transaction(async (tx) => {
    // Serialize decisions for this scan; the guard below then reads a consistent state.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${params.scanId}))`);

    const scanRows = await tx
      .select({ status: scans.status })
      .from(scans)
      .where(and(eq(scans.id, params.scanId), eq(scans.ownerId, params.ownerId)))
      .limit(1);
    const scan = scanRows[0];
    // Owner-scoped + must still be at the gate. Not owned or not awaiting → stale/duplicate submit.
    if (scan === undefined || scan.status !== 'awaiting_approval') {
      return { kind: 'not_awaiting' };
    }

    const hyps = await tx
      .select({ id: hypotheses.id, status: hypotheses.status })
      .from(hypotheses)
      .where(eq(hypotheses.scanId, params.scanId));
    const pending = new Set(hyps.filter((h) => h.status === 'pending').map((h) => h.id));

    const approvedSet = new Set(params.approvedHypotheses);
    // Every approved id must be a pending hypothesis OF THIS SCAN — reject foreign/unknown/already
    // decided ids rather than silently approving a subset (fail loud, invariant #1).
    const unknown = [...approvedSet].filter((id) => !pending.has(id));
    if (unknown.length > 0) {
      return { kind: 'invalid_hypotheses', unknown };
    }

    const approved = [...approvedSet];
    const rejected = [...pending].filter((id) => !approvedSet.has(id));

    if (approved.length > 0) {
      await tx
        .update(hypotheses)
        .set({ status: 'approved' })
        .where(and(eq(hypotheses.scanId, params.scanId), inArray(hypotheses.id, approved)));
    }
    if (rejected.length > 0) {
      await tx
        .update(hypotheses)
        .set({ status: 'rejected' })
        .where(and(eq(hypotheses.scanId, params.scanId), inArray(hypotheses.id, rejected)));
    }

    // Audit each decision with the HUMAN as actor (Flow D: rejections recorded with the analyst;
    // ADR-16). Safe identifiers only — a hypothesis id, never a payload or secret (§5).
    const auditRows = [
      ...approved.map((id) => ({
        scanId: params.scanId,
        action: 'hypothesis.approved',
        actor: params.ownerId,
        detail: `hypothesis=${id}`,
      })),
      ...rejected.map((id) => ({
        scanId: params.scanId,
        action: 'hypothesis.rejected',
        actor: params.ownerId,
        detail: `hypothesis=${id}`,
      })),
    ];
    if (auditRows.length > 0) {
      await tx.insert(auditLog).values(auditRows);
    }

    // Leave the gate: a duplicate/concurrent submit now hits the status guard above and is rejected.
    await tx.update(scans).set({ status: 'testing' }).where(eq(scans.id, params.scanId));

    return { kind: 'accepted', approved, rejected };
  });
}
