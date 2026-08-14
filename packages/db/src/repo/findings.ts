import type { VulnClass } from '@corvid/tool-contracts';
import { eq } from 'drizzle-orm';

import type { Database } from '../client.ts';
import { findings, hypotheses } from '../schema/domain.ts';

export type FindingRow = typeof findings.$inferSelect;

export interface NewFinding {
  readonly hypothesisId: string;
  readonly vulnClass: VulnClass;
  /** The technique/payload family that fired — a safe descriptor, never a raw secret or body (§5). */
  readonly payload: string;
  /** The deterministic proof the verification gate produced (why the exploit provably fired). */
  readonly proof: string;
  /** CVSS 3.1 base vector + score (D-3, ADR-D3). */
  readonly severity?: string;
}

/**
 * Persist a VERIFIED finding. The findings store holds verified findings ONLY: the verification gate
 * (`02` §4.4) discards an unverified observation before this is ever called, so `verified` is always
 * true here — it is the single field the report writer checks (ADR-05). Replay-safety (one finding
 * per hypothesis via a unique index + onConflictDoNothing) is added when the verify node is wired
 * into the graph (Unit 5 slab 6).
 */
export async function insertFinding(db: Database, finding: NewFinding): Promise<FindingRow> {
  const rows = await db
    .insert(findings)
    .values({
      hypothesisId: finding.hypothesisId,
      vulnClass: finding.vulnClass,
      payload: finding.payload,
      proof: finding.proof,
      verified: true,
      ...(finding.severity !== undefined ? { severity: finding.severity } : {}),
    })
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error('insertFinding: insert returned no row');
  return row;
}

/** All findings for a scan, resolved through the hypothesis → scan link. Read by the report writer. */
export async function listFindingsForScan(db: Database, scanId: string): Promise<FindingRow[]> {
  const rows = await db
    .select({ finding: findings })
    .from(findings)
    .innerJoin(hypotheses, eq(findings.hypothesisId, hypotheses.id))
    .where(eq(hypotheses.scanId, scanId));
  return rows.map((r) => r.finding);
}
