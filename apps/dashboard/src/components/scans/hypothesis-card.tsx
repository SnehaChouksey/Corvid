import { HypothesisStatusBadge } from '@/components/status-badge';
import { Card, CardContent } from '@/components/ui/card';
import type { Hypothesis } from '@/lib/api/schemas';
import { VULN_CLASS_LABEL } from '@/lib/status';

export function HypothesisCard({ hypothesis }: { readonly hypothesis: Hypothesis }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] tracking-wide text-muted-foreground uppercase">
              {VULN_CLASS_LABEL[hypothesis.vulnClass]}
            </span>
            <span className="truncate font-mono text-sm">{hypothesis.endpoint}</span>
          </div>
          <HypothesisStatusBadge status={hypothesis.status} />
        </div>
        <p className="text-sm text-muted-foreground">{hypothesis.rationale}</p>
        {hypothesis.plan !== null ? (
          <div className="mt-1 rounded-md border border-border/60 bg-muted/40 px-3 py-2 font-mono text-xs">
            <span className="text-muted-foreground">{hypothesis.plan.method}</span>
            {hypothesis.plan.param !== undefined ? (
              <>
                {' · '}
                <span className="text-muted-foreground">
                  {hypothesis.plan.param.location}:{hypothesis.plan.param.name}
                </span>
              </>
            ) : null}
            {' · '}
            <span className="text-muted-foreground">{hypothesis.plan.payloadFamily}</span>
            {hypothesis.plan.intendedPayload !== undefined ? (
              <div className="mt-1.5 overflow-x-auto text-foreground">{hypothesis.plan.intendedPayload}</div>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
