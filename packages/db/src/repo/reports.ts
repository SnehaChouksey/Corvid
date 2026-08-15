import { type Report, reportSchema, type VulnClass } from '@corvid/tool-contracts';
import { and, eq } from 'drizzle-orm';

import type { Database } from '../client.ts';
import { findings, hypotheses, reports, scans, targets } from '../schema/domain.ts';

export type ReportRow = typeof reports.$inferSelect;

/**
 * The verified-only, reasoning-free input the Report Writer builds from (ADR-05). Deliberately a
 * NARROW projection: it joins `findings` (verified-only by the DB check constraint) to `hypotheses`
 * for the endpoint ONLY — never `hypotheses.rationale`/`plan`/`status`. This is the structural half
 * of "the report writer has no code path to unverified hypotheses": the data source itself cannot
 * carry raw agent reasoning.
 */
export interface ReportFindingData {
  readonly vulnClass: VulnClass;
  readonly endpoint: string;
  readonly payload: string;
  readonly proof: string;
  readonly severity: string | null;
  readonly reportedAt: Date;
}

export interface ScanReportData {
  readonly scanId: string;
  /** The scan owner — the report writer attributes its LLM spend to this user (ADR-21). */
  readonly ownerId: string;
  readonly targetUrl: string;
  readonly findings: readonly ReportFindingData[];
}

/**
 * Load everything the report writer needs for a scan: the target url plus the verified findings with
 * their endpoints. Trusted-caller read (by scan id) — the owner check happens at the gateway boundary
 * before this runs, matching the other per-scan reads. Returns undefined only if the scan is gone.
 */
export async function getScanReportData(db: Database, scanId: string): Promise<ScanReportData | undefined> {
  const scanRows = await db
    .select({ scanId: scans.id, ownerId: scans.ownerId, targetUrl: targets.url })
    .from(scans)
    .innerJoin(targets, eq(scans.targetId, targets.id))
    .where(eq(scans.id, scanId));
  const scan = scanRows[0];
  if (scan === undefined) return undefined;

  const rows = await db
    .select({
      vulnClass: findings.vulnClass,
      endpoint: hypotheses.endpoint,
      payload: findings.payload,
      proof: findings.proof,
      severity: findings.severity,
      reportedAt: findings.reportedAt,
    })
    .from(findings)
    .innerJoin(hypotheses, eq(findings.hypothesisId, hypotheses.id))
    .where(eq(hypotheses.scanId, scanId));

  return { scanId: scan.scanId, ownerId: scan.ownerId, targetUrl: scan.targetUrl, findings: rows };
}

/**
 * Upsert the generated report for a scan (idempotent per scan — the fan-out job can retry/replay).
 * The PDF is written alongside when rendered; a later re-run overwrites both with the latest render.
 */
export async function upsertReport(
  db: Database,
  input: { readonly scanId: string; readonly content: Report; readonly pdf?: Buffer },
): Promise<void> {
  // Validate at the storage boundary (§1): the content carries LLM-derived prose, so a drift/garbage
  // shape fails loud here rather than being served to a customer as a malformed artifact.
  const content = reportSchema.parse(input.content);
  await db
    .insert(reports)
    .values({
      scanId: input.scanId,
      content,
      ...(input.pdf !== undefined ? { pdf: input.pdf } : {}),
    })
    .onConflictDoUpdate({
      target: reports.scanId,
      // Only overwrite the PDF when a fresh one was rendered — a retry whose PDF render failed must
      // NOT clobber a good PDF stored by an earlier attempt.
      set: {
        content,
        generatedAt: new Date(),
        ...(input.pdf !== undefined ? { pdf: input.pdf } : {}),
      },
    });
}

/** System read of the stored report content by scan id (the worker reuses it on retry to avoid re-billing). */
export async function getReport(db: Database, scanId: string): Promise<Report | undefined> {
  const rows = await db.select({ content: reports.content }).from(reports).where(eq(reports.scanId, scanId));
  return rows[0]?.content;
}

/** The report's JSON content for a scan the caller owns, or undefined (404 at the gateway). */
export async function getReportForScanOwner(
  db: Database,
  ownerId: string,
  scanId: string,
): Promise<{ content: Report; generatedAt: Date } | undefined> {
  const rows = await db
    .select({ content: reports.content, generatedAt: reports.generatedAt })
    .from(reports)
    .innerJoin(scans, eq(reports.scanId, scans.id))
    .where(and(eq(reports.scanId, scanId), eq(scans.ownerId, ownerId)));
  return rows[0];
}

/** The report's rendered PDF for a scan the caller owns, or undefined (no PDF yet / not owned). */
export async function getReportPdfForScanOwner(
  db: Database,
  ownerId: string,
  scanId: string,
): Promise<Buffer | undefined> {
  const rows = await db
    .select({ pdf: reports.pdf })
    .from(reports)
    .innerJoin(scans, eq(reports.scanId, scans.id))
    .where(and(eq(reports.scanId, scanId), eq(scans.ownerId, ownerId)));
  const pdf = rows[0]?.pdf;
  return pdf ?? undefined;
}
