import type { CorvidLogger } from '@corvid/logger';
import type { ReportJobHandler } from '@corvid/redis';
import { generateReport, renderReportHtml, type ReportContext } from '@corvid/report';
import type { Report } from '@corvid/tool-contracts';

// The report fan-out job handler (ADR-17, Unit 7). Ordering is the safety-relevant part: the report
// (verified-only, ADR-05) is STORED before the scan is marked `completed`, so "completed" always
// means "the report exists" — a consumer never sees a completed scan with no report. The JSON report
// is the source of truth; the PDF is a rendered form of it, so a PDF render failure degrades that one
// export (logged + audited, not silent) and never blocks the report or scan completion.

export interface ReportWorkerDeps {
  readonly reportCtx: ReportContext;
  /** Render the report HTML to a PDF (the Playwright renderer in the composition root). */
  renderPdf(html: string): Promise<Buffer>;
  /** Persist the report + PDF (upsertReport — idempotent per scan). */
  saveReport(input: { scanId: string; content: Report; pdf?: Buffer }): Promise<void>;
  /** Mark the scan completed (setScanStatus) — only after the report is stored. */
  completeScan(scanId: string): Promise<void>;
  /** Append an audit record (ADR-16) — the worker is a system actor. */
  audit(entry: { scanId: string; action: string; detail?: string }): Promise<void>;
  readonly logger?: CorvidLogger;
}

export function buildReportHandler(deps: ReportWorkerDeps): ReportJobHandler {
  return async ({ scanId }): Promise<void> => {
    const report = await generateReport(deps.reportCtx, { scanId });

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
    // Completion follows the stored report (the reporting → completed transition, `02` §5.1).
    await deps.completeScan(scanId);
    await deps.audit({
      scanId,
      action: 'report.generated',
      detail: `findings=${report.findings.length} clean=${report.clean} pdf=${pdf !== undefined}`,
    });
  };
}
