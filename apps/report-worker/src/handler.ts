import type { CorvidLogger } from '@corvid/logger';
import type { ReportJobHandler } from '@corvid/redis';
import { generateReport, renderReportHtml, type ReportContext } from '@corvid/report';
import type { Report, ScanStatus } from '@corvid/tool-contracts';

// The report fan-out job handler (ADR-17/ADR-34, Unit 7). Ordering + guards are the safety-relevant
// part: the report (verified-only, ADR-05) is STORED before the scan is marked `completed`, so
// "completed" always means "the report exists". Completion is GUARDED to `reporting` only, so a scan
// cancelled while the report is generating is never resurrected to `completed`. The JSON report is the
// source of truth; a PDF render failure degrades that one export (logged + audited), never the report.

export interface ReportWorkerDeps {
  readonly reportCtx: ReportContext;
  /** Current scan status (system read) — the job is a no-op if the scan is no longer `reporting`. */
  loadScanStatus(scanId: string): Promise<ScanStatus | undefined>;
  /** An already-generated report, if any — reused on retry so a post-LLM failure never re-bills (ADR-21). */
  loadExistingReport(scanId: string): Promise<Report | undefined>;
  /** Render the report HTML to a PDF (the Playwright renderer in the composition root). */
  renderPdf(html: string): Promise<Buffer>;
  /** Persist the report + PDF (upsertReport — idempotent per scan). */
  saveReport(input: { scanId: string; content: Report; pdf?: Buffer }): Promise<void>;
  /** Complete the scan iff still `reporting` (guarded); returns false if it left `reporting` (e.g. cancelled). */
  completeScan(scanId: string): Promise<boolean>;
  /** Append an audit record (ADR-16) — the worker is a system actor. */
  audit(entry: { scanId: string; action: string; detail?: string }): Promise<void>;
  readonly logger?: CorvidLogger;
}

export function buildReportHandler(deps: ReportWorkerDeps): ReportJobHandler {
  return async ({ scanId }): Promise<void> => {
    // Skip if the scan is no longer awaiting a report (e.g. cancelled after the job was enqueued) —
    // never generate/bill/store a report for a scan that has moved on.
    const status = await deps.loadScanStatus(scanId);
    if (status !== 'reporting') {
      deps.logger?.warn({ scanId, status: status ?? 'missing' }, 'report job skipped: scan not in reporting');
      await deps.audit({ scanId, action: 'report.superseded', detail: `status=${status ?? 'missing'}` });
      return;
    }

    // Reuse an already-generated report on a retry (a failure after the LLM call) so we don't re-bill.
    const report = (await deps.loadExistingReport(scanId)) ?? (await generateReport(deps.reportCtx, { scanId }));

    // Render the PDF best-effort: the report JSON is authoritative, so a Chromium failure degrades the
    // PDF export only. Never silent — logged here and recorded in the audit detail below.
    let pdf: Buffer | undefined;
    try {
      pdf = await deps.renderPdf(renderReportHtml(report));
    } catch (err) {
      deps.logger?.error(
        { scanId, err_name: err instanceof Error ? err.name : 'unknown' },
        'report PDF render failed — storing report without PDF (JSON + dashboard exports unaffected)',
      );
    }

    await deps.saveReport({ scanId, content: report, ...(pdf !== undefined ? { pdf } : {}) });

    // Guarded completion: only `reporting` → `completed`. If the scan left `reporting` mid-generation
    // (cancelled), do not complete it — the stored report is harmless; the scan keeps its real state.
    const completed = await deps.completeScan(scanId);
    if (!completed) {
      deps.logger?.warn({ scanId }, 'scan left reporting during report generation — not completed');
      await deps.audit({ scanId, action: 'report.superseded', detail: 'left reporting during generation' });
      return;
    }
    await deps.audit({
      scanId,
      action: 'report.generated',
      detail: `findings=${report.findings.length} clean=${report.clean} pdf=${pdf !== undefined}`,
    });
  };
}
