import type { Report, ReportFinding, SeverityBand } from '@corvid/tool-contracts';

// Deterministic renderers for the report's non-dashboard forms (ADR-26). Both are pure functions of
// the Report object — the same verified-only source as the dashboard view. `renderReportJson` is the
// machine-readable export; `renderReportHtml` is a self-contained, print-styled document the worker
// converts to PDF (via Playwright). No LLM, no network, no unverified data here.

/** The machine-readable JSON export (ADR-26) — stable, pretty-printed. */
export function renderReportJson(report: Report): string {
  return JSON.stringify(report, null, 2);
}

// Escape the five XML/HTML-significant characters so a finding's payload/proof/endpoint can never
// break out of its text node into markup in the rendered document.
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const BAND_COLOR: Record<SeverityBand, string> = {
  critical: '#b91c1c',
  high: '#c2410c',
  medium: '#b45309',
  low: '#0369a1',
  none: '#4b5563',
};

const BAND_LABEL: Record<SeverityBand, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  none: 'None',
};

function severityText(f: ReportFinding): string {
  const band = BAND_LABEL[f.severity.band];
  const score = f.severity.score === null ? '' : ` ${f.severity.score.toFixed(1)}`;
  return `${band}${score}`;
}

function findingBlock(f: ReportFinding, index: number): string {
  const color = BAND_COLOR[f.severity.band];
  const vector = f.severity.vector === null ? '' : `<div class="vector">${esc(f.severity.vector)}</div>`;
  const remediation =
    f.remediation === null
      ? ''
      : `<div class="field"><div class="label">Remediation</div><div class="prose">${esc(f.remediation)}</div></div>`;
  return `
    <section class="finding" style="border-left-color:${color}">
      <div class="finding-head">
        <span class="vclass">${esc(f.vulnClass.toUpperCase())}</span>
        <span class="badge" style="background:${color}">${esc(severityText(f))}</span>
      </div>
      <div class="endpoint">${esc(f.endpoint)}</div>
      ${vector}
      <div class="field"><div class="label">Payload</div><pre>${esc(f.payload)}</pre></div>
      <div class="field"><div class="label">Proof</div><pre>${esc(f.proof)}</pre></div>
      ${remediation}
      <div class="meta">Finding ${index + 1} · verified ${esc(f.reportedAt)}</div>
    </section>`;
}

/**
 * A self-contained, print-optimized HTML document (ADR-26 PDF source). Inline CSS only — no external
 * assets — so Playwright renders it to a faithful PDF with no network access.
 */
export function renderReportHtml(report: Report): string {
  const findings =
    report.findings.length === 0
      ? '<p class="clean">No verified vulnerabilities were found.</p>'
      : report.findings.map(findingBlock).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Corvid Security Report — ${esc(report.target.url)}</title>
<style>
  @page { margin: 20mm 16mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #111827; font-size: 12px; line-height: 1.5; margin: 0; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 24px 0 8px; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; }
  .sub { color: #6b7280; font-size: 11px; }
  .summary { margin: 6px 0 0; }
  .narrative-note { margin: 4px 0 0; color: #9ca3af; font-size: 10px; font-style: italic; }
  .count { margin: 6px 0 0; font-weight: 600; }
  .clean { color: #047857; font-weight: 600; }
  .finding { border: 1px solid #e5e7eb; border-left-width: 4px; border-radius: 6px; padding: 12px 14px; margin: 12px 0; page-break-inside: avoid; }
  .finding-head { display: flex; align-items: center; justify-content: space-between; }
  .vclass { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; letter-spacing: 0.06em; color: #374151; }
  .badge { color: #fff; font-weight: 600; font-size: 11px; padding: 2px 8px; border-radius: 999px; }
  .endpoint { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; margin: 8px 0 4px; word-break: break-all; }
  .vector { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; color: #6b7280; margin-bottom: 6px; word-break: break-all; }
  .field { margin-top: 8px; }
  .label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: #6b7280; margin-bottom: 2px; }
  pre { background: #f9fafb; border: 1px solid #f3f4f6; border-radius: 4px; padding: 8px; margin: 0; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
  .prose { white-space: pre-wrap; }
  .meta { color: #9ca3af; font-size: 10px; margin-top: 8px; }
  footer { margin-top: 28px; color: #9ca3af; font-size: 10px; border-top: 1px solid #e5e7eb; padding-top: 8px; }
</style>
</head>
<body>
  <h1>Security Report</h1>
  <div class="sub">${esc(report.target.url)} · generated ${esc(report.generatedAt)}</div>
  <h2>Executive Summary</h2>
  <p class="narrative-note">Generated narrative. The verified findings below are the authoritative record.</p>
  <p class="summary">${esc(report.summary)}</p>
  <p class="count">${report.findings.length} verified finding${report.findings.length === 1 ? '' : 's'}</p>
  <h2>Findings</h2>
  ${findings}
  <footer>Corvid — verified findings only. Every finding above was confirmed by a deterministic, non-LLM verification check.</footer>
</body>
</html>`;
}
