import { SeverityBadge } from '@/components/severity-badge';
import { Card, CardContent } from '@/components/ui/card';
import type { Finding } from '@/lib/api/schemas';
import { formatDateTime } from '@/lib/format';
import { parseSeverity } from '@/lib/severity';
import { VULN_CLASS_LABEL } from '@/lib/status';
import { cn } from '@/lib/utils';

const BAND_BORDER: Record<string, string> = {
  critical: 'border-l-severity-critical',
  high: 'border-l-severity-high',
  medium: 'border-l-severity-medium',
  low: 'border-l-severity-low',
  none: 'border-l-severity-none',
  unknown: 'border-l-border',
};

export function FindingCard({ finding }: { readonly finding: Finding }) {
  const { band } = parseSeverity(finding.severity);
  return (
    <Card className={cn('border-l-2', BAND_BORDER[band])}>
      <CardContent className="flex flex-col gap-3 py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] tracking-wide text-muted-foreground uppercase">
              {VULN_CLASS_LABEL[finding.vulnClass]}
            </span>
            <SeverityBadge severity={finding.severity} />
          </div>
          <span className="text-xs text-muted-foreground">{formatDateTime(finding.reportedAt)}</span>
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
      </CardContent>
    </Card>
  );
}
