import { parseSeverity, SEVERITY_LABEL } from '@/lib/severity';
import { cn } from '@/lib/utils';

export function SeverityBadge({ severity }: { readonly severity: string | null }) {
  const { band, score } = parseSeverity(severity);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold tracking-wide',
        band === 'critical' && 'border-severity-critical/40 bg-severity-critical/15 text-severity-critical',
        band === 'high' && 'border-severity-high/40 bg-severity-high/15 text-severity-high',
        band === 'medium' && 'border-severity-medium/40 bg-severity-medium/15 text-severity-medium',
        band === 'low' && 'border-severity-low/40 bg-severity-low/15 text-severity-low',
        band === 'none' && 'border-severity-none/40 bg-severity-none/15 text-severity-none',
        band === 'unknown' && 'border-border bg-muted text-muted-foreground',
      )}
      title={severity ?? undefined}
    >
      {SEVERITY_LABEL[band]}
      {score !== null ? <span className="font-mono font-normal opacity-80">{score.toFixed(1)}</span> : null}
    </span>
  );
}
