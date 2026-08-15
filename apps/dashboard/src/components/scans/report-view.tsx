'use client';

import { useState } from 'react';
import { TbAlertCircle, TbCircleCheck, TbFileText, TbFileTypePdf, TbLoader2 } from 'react-icons/tb';

import { ApiErrorPanel } from '@/components/api-error';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { apiErrorMessage, isApiError } from '@/lib/api/client';
import type { Report, ReportFinding } from '@/lib/api/schemas';
import { downloadReport, useReport } from '@/lib/api/scans';
import { formatDateTime } from '@/lib/format';
import { SEVERITY_LABEL, type SeverityBand } from '@/lib/severity';
import { VULN_CLASS_LABEL } from '@/lib/status';
import { cn } from '@/lib/utils';

// The report's severity band/score/vector are pre-derived server-side (ADR-26) — this view only
// ever renders them, it never re-parses a CVSS string.

const BAND_BORDER: Record<SeverityBand, string> = {
  critical: 'border-l-severity-critical',
  high: 'border-l-severity-high',
  medium: 'border-l-severity-medium',
  low: 'border-l-severity-low',
  none: 'border-l-severity-none',
};

const BAND_BADGE: Record<SeverityBand, string> = {
  critical: 'border-severity-critical/40 bg-severity-critical/15 text-severity-critical',
  high: 'border-severity-high/40 bg-severity-high/15 text-severity-high',
  medium: 'border-severity-medium/40 bg-severity-medium/15 text-severity-medium',
  low: 'border-severity-low/40 bg-severity-low/15 text-severity-low',
  none: 'border-severity-none/40 bg-severity-none/15 text-severity-none',
};

export function ReportView({ scanId }: { readonly scanId: string }) {
  const { data, isPending, isError, error } = useReport(scanId);

  if (isPending) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (isError) {
    return <ApiErrorPanel error={error} notFoundLabel="report" />;
  }

  if (!data.ready || data.report === null) {
    return <GeneratingState />;
  }

  const { report } = data;

  return (
    <div className="flex flex-col gap-4">
      <ReportHeader report={report} scanId={scanId} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Executive summary</CardTitle>
          <p className="text-xs text-muted-foreground">
            Generated narrative — the verified findings below are the authoritative record.
          </p>
        </CardHeader>
        <CardContent>
          <p className="text-sm leading-relaxed whitespace-pre-wrap text-foreground/90">{report.summary}</p>
        </CardContent>
      </Card>

      {report.clean ? (
        <Alert variant="success">
          <TbCircleCheck />
          <AlertTitle>Clean report</AlertTitle>
          <AlertDescription>No verified vulnerabilities were found on the tested surface.</AlertDescription>
        </Alert>
      ) : (
        <div className="flex flex-col gap-3">
          {report.findings.map((finding, i) => (
            <ReportFindingCard key={`${finding.vulnClass}-${finding.endpoint}-${i}`} finding={finding} />
          ))}
        </div>
      )}
    </div>
  );
}

function GeneratingState() {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
        <TbLoader2 className="size-5 animate-spin text-muted-foreground motion-reduce:animate-none" />
        <div>
          <p className="text-sm font-medium">Generating report…</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Corvid is compiling the verified findings from this scan into the final report. This usually takes a
            few seconds.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function ReportHeader({ report, scanId }: { readonly report: Report; readonly scanId: string }) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-start justify-between gap-4 py-4">
        <div>
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Target</p>
          <p className="mt-1 font-mono text-sm">{report.target.url}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            Generated {formatDateTime(report.generatedAt)} · {report.findings.length} verified finding
            {report.findings.length === 1 ? '' : 's'}
          </p>
        </div>
        <ExportButtons scanId={scanId} />
      </CardContent>
    </Card>
  );
}

type ExportFormat = 'json' | 'pdf';

function ExportButtons({ scanId }: { readonly scanId: string }) {
  const [pending, setPending] = useState<ExportFormat | null>(null);
  const [failure, setFailure] = useState<{ format: ExportFormat; message: string } | null>(null);

  async function handleDownload(format: ExportFormat) {
    setFailure(null);
    setPending(format);
    try {
      await downloadReport(scanId, format);
    } catch (err) {
      const fallback = format === 'pdf' ? 'PDF not available yet.' : "Couldn't download the JSON report.";
      setFailure({ format, message: isApiError(err) ? apiErrorMessage(err.body, fallback) : fallback });
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={pending !== null} onClick={() => void handleDownload('json')}>
          {pending === 'json' ? <TbLoader2 className="animate-spin" /> : <TbFileText />}
          Download JSON
        </Button>
        <Button variant="outline" size="sm" disabled={pending !== null} onClick={() => void handleDownload('pdf')}>
          {pending === 'pdf' ? <TbLoader2 className="animate-spin" /> : <TbFileTypePdf />}
          Download PDF
        </Button>
      </div>
      {failure !== null ? (
        <Alert variant="destructive" className="w-full max-w-sm">
          <TbAlertCircle />
          <AlertTitle>Couldn&apos;t download {failure.format.toUpperCase()}</AlertTitle>
          <AlertDescription>{failure.message}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function ReportFindingCard({ finding }: { readonly finding: ReportFinding }) {
  return (
    <Card className={cn('border-l-2', BAND_BORDER[finding.severity.band])}>
      <CardContent className="flex flex-col gap-3 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] tracking-wide text-muted-foreground uppercase">
              {VULN_CLASS_LABEL[finding.vulnClass]}
            </span>
            <ReportSeverityBadge severity={finding.severity} />
          </div>
          <span className="text-xs text-muted-foreground">{formatDateTime(finding.reportedAt)}</span>
        </div>

        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-mono text-sm">{finding.endpoint}</span>
          {finding.severity.vector !== null ? (
            <span className="font-mono text-[11px] text-muted-foreground">{finding.severity.vector}</span>
          ) : null}
        </div>

        <div>
          <p className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Payload</p>
          <pre className="overflow-x-auto rounded-md border border-border/60 bg-muted/40 px-3 py-2 font-mono text-xs whitespace-pre-wrap">
            {finding.payload}
          </pre>
        </div>

        <div>
          <p className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Proof</p>
          <pre className="overflow-x-auto rounded-md border border-border/60 bg-muted/40 px-3 py-2 font-mono text-xs whitespace-pre-wrap">
            {finding.proof}
          </pre>
        </div>

        {finding.remediation !== null ? (
          <div>
            <p className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Remediation</p>
            <pre className="overflow-x-auto rounded-md border border-primary/25 bg-primary/5 px-3 py-2 font-mono text-xs whitespace-pre-wrap">
              {finding.remediation}
            </pre>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ReportSeverityBadge({ severity }: { readonly severity: ReportFinding['severity'] }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold tracking-wide',
        BAND_BADGE[severity.band],
      )}
      title={severity.raw ?? undefined}
    >
      {SEVERITY_LABEL[severity.band]}
      {severity.score !== null ? <span className="font-mono font-normal opacity-80">{severity.score.toFixed(1)}</span> : null}
    </span>
  );
}
