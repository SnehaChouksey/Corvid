import type { HypothesisStatus, ScanStatus } from '@corvid/tool-contracts';

import { cn } from '@/lib/utils';
import { HYPOTHESIS_STATUS_LABEL, SCAN_STATUS_LABEL, SCAN_STATUS_LIVE, SCAN_STATUS_TERMINAL } from '@/lib/status';

/** The scan lifecycle badge (`01` §12: the badge must reflect the workflow truthfully). */
export function ScanStatusBadge({ status, className }: { readonly status: ScanStatus; readonly className?: string }) {
  const live = SCAN_STATUS_LIVE[status];
  const terminal = SCAN_STATUS_TERMINAL[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium tracking-wide',
        live && 'border-primary/40 bg-primary/10 text-primary',
        status === 'awaiting_approval' && 'border-warning/40 bg-warning/10 text-warning',
        status === 'completed' && 'border-success/40 bg-success/10 text-success',
        (status === 'rejected' || status === 'cancelled' || status === 'stopped') &&
          'border-muted-foreground/30 bg-muted text-muted-foreground',
        !live && status !== 'awaiting_approval' && !terminal && 'border-border bg-muted text-muted-foreground',
        className,
      )}
    >
      <span
        className={cn(
          'size-1.5 rounded-full',
          live ? 'bg-primary animate-live-pulse' : 'bg-current opacity-70',
        )}
        aria-hidden
      />
      {SCAN_STATUS_LABEL[status]}
    </span>
  );
}

export function HypothesisStatusBadge({ status }: { readonly status: HypothesisStatus }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium tracking-wide',
        status === 'pending' && 'border-border text-muted-foreground',
        status === 'approved' && 'border-primary/40 bg-primary/10 text-primary',
        status === 'rejected' && 'border-muted-foreground/30 bg-muted text-muted-foreground',
        status === 'tested' && 'border-primary/40 bg-primary/10 text-primary',
        status === 'confirmed' && 'border-destructive/40 bg-destructive/10 text-destructive',
        status === 'not_confirmed' && 'border-success/40 bg-success/10 text-success',
      )}
    >
      {HYPOTHESIS_STATUS_LABEL[status]}
    </span>
  );
}
