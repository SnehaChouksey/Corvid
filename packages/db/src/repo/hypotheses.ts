import type { HypothesisPlan, VulnClass } from '@corvid/tool-contracts';
import { and, asc, eq } from 'drizzle-orm';

import type { Database } from '../client.ts';
import { hypotheses } from '../schema/domain.ts';

export type HypothesisRow = typeof hypotheses.$inferSelect;

export interface NewHypothesis {
  readonly scanId: string;
  readonly vulnClass: VulnClass;
  readonly endpoint: string;
  readonly rationale: string;
  readonly fingerprint: string;
  readonly plan?: HypothesisPlan;
}

/**
 * Insert freshly-generated hypotheses as `pending`, deduped per scan by `fingerprint`.
 * `onConflictDoNothing` on the unique `(scan_id, fingerprint)` key makes this REPLAY-SAFE: a
 * hypothesize node re-runs from its start on resume (ADR-27), and a replay of the same batch is a
 * no-op — the DB is the durable dedup authority. Returns only the rows actually inserted, so a full
 * replay returns `[]` (nothing new persisted, no duplicates).
 */
export async function insertHypotheses(
  db: Database,
  rows: readonly NewHypothesis[],
): Promise<HypothesisRow[]> {
  if (rows.length === 0) return [];
  return db
    .insert(hypotheses)
    .values(
      rows.map((r) => ({
        scanId: r.scanId,
        vulnClass: r.vulnClass,
        endpoint: r.endpoint,
        rationale: r.rationale,
        fingerprint: r.fingerprint,
        status: 'pending' as const,
        plan: r.plan ?? null,
      })),
    )
    .onConflictDoNothing({ target: [hypotheses.scanId, hypotheses.fingerprint] })
    .returning();
}

/**
 * All hypotheses for a scan, oldest first. Read by the trusted orchestrator via a scan id it was
 * handed (like `getTargetForScan`); the owner-scoped dashboard read lands in Unit 6.
 */
export async function listHypothesesForScan(db: Database, scanId: string): Promise<HypothesisRow[]> {
  return db
    .select()
    .from(hypotheses)
    .where(eq(hypotheses.scanId, scanId))
    .orderBy(asc(hypotheses.createdAt));
}

/**
 * Replace a hypothesis's `plan` (the `plan` node's output: selected tool + intended payload on top
 * of the fingerprint inputs). Scoped by scan id as well as hypothesis id so a plan write can't touch
 * another scan's row. Returns the updated row, or undefined if no such hypothesis in that scan.
 */
export async function setHypothesisPlan(
  db: Database,
  scanId: string,
  hypothesisId: string,
  plan: HypothesisPlan,
): Promise<HypothesisRow | undefined> {
  const rows = await db
    .update(hypotheses)
    .set({ plan })
    .where(and(eq(hypotheses.id, hypothesisId), eq(hypotheses.scanId, scanId)))
    .returning();
  return rows[0];
}
