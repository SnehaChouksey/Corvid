'use client';

import { TbAlertOctagon, TbArrowLeft, TbCircleCheck, TbClock } from 'react-icons/tb';
import Link from 'next/link';
import { use, useState } from 'react';

import { ApiErrorPanel } from '@/components/api-error';
import { FindingCard } from '@/components/scans/finding-card';
import { HypothesisCard } from '@/components/scans/hypothesis-card';
import { ScanStatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { apiErrorMessage, isApiError } from '@/lib/api/client';
import { useAudit, useCancelScan, useFindings, useHypotheses, useScan } from '@/lib/api/scans';
import { formatDateTime } from '@/lib/format';
import { SCAN_STATUS_TERMINAL } from '@/lib/status';

export default function ScanDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: scan, isPending, isError, error } = useScan(id);
  const [cancelOpen, setCancelOpen] = useState(false);
  const cancelScan = useCancelScan(id);

  const terminal = scan !== undefined ? SCAN_STATUS_TERMINAL[scan.status] : false;
  const { data: hypotheses, isPending: hypPending, isError: hypError, error: hypErr } = useHypotheses(id, {
    poll: !terminal,
  });
  const { data: findings, isPending: findPending, isError: findError, error: findErr } = useFindings(id, {
    poll: !terminal,
  });
  const { data: audit, isPending: auditPending, isError: auditError, error: auditErr } = useAudit(id, { poll: !terminal });

  if (isPending) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-9 w-96" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (isError) {
    return <ApiErrorPanel error={error} notFoundLabel="scan" />;
  }

  return (
    <div className="flex flex-col gap-6">
      <Link href="/scans" className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <TbArrowLeft className="size-3.5" />
        Scans
      </Link>

      <div className="flex items-start justify-between gap-6">
        <div>
          <p className="font-mono text-xs text-muted-foreground">{scan.id}</p>
          <div className="mt-2 flex items-center gap-3">
            <ScanStatusBadge status={scan.status} className="text-sm" />
            <Link href={`/targets/${scan.targetId}`} className="text-sm text-muted-foreground hover:text-foreground hover:underline">
              View target →
            </Link>
          </div>
        </div>
        {!terminal ? (
          <Button variant="outline" size="sm" onClick={() => setCancelOpen(true)} disabled={cancelScan.isPending}>
            <TbAlertOctagon />
            Cancel scan
          </Button>
        ) : null}
      </div>

      {scan.status === 'awaiting_approval' ? (
        <Alert variant="warning">
          <TbClock />
          <AlertTitle>Paused — waiting on your review</AlertTitle>
          <AlertDescription>
            Nothing is being tested right now, and nothing will be until you decide. This can wait as long as
            you need.{' '}
            <Link href={`/scans/${id}/approve`} className="font-medium underline">
              Go to the approval gate →
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}

      {scan.status === 'stopped' ? (
        <Alert variant="destructive">
          <TbAlertOctagon />
          <AlertTitle>Stopped before the approval gate</AlertTitle>
          <AlertDescription>
            {hypotheses !== undefined && hypotheses.length === 0
              ? "Hypothesis generation didn't return anything usable for this run. No hypotheses exist to review, and no traffic was sent."
              : 'This scan stopped before reaching the approval gate. No traffic was sent to the target.'}
          </AlertDescription>
        </Alert>
      ) : null}

      {scan.status === 'completed' && findings !== undefined && findings.length === 0 ? (
        <Alert variant="success">
          <TbCircleCheck />
          <AlertTitle>Clean report</AlertTitle>
          <AlertDescription>The scan completed and found no verified issues in the tested surface.</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid grid-cols-3 gap-4 text-sm">
        <Card>
          <CardContent className="py-4">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Started</p>
            <p className="mt-1 font-mono text-xs">{scan.startedAt !== null ? formatDateTime(scan.startedAt) : '—'}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Completed</p>
            <p className="mt-1 font-mono text-xs">{scan.completedAt !== null ? formatDateTime(scan.completedAt) : '—'}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Findings</p>
            <p className="mt-1 font-mono text-xs">{findings?.length ?? '—'}</p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="hypotheses">
        <TabsList>
          <TabsTrigger value="hypotheses">Hypotheses{hypotheses !== undefined ? ` (${hypotheses.length})` : ''}</TabsTrigger>
          <TabsTrigger value="findings">
            {terminal ? 'Report' : 'Findings'}
            {findings !== undefined ? ` (${findings.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value="audit">Audit trail</TabsTrigger>
        </TabsList>

        <TabsContent value="hypotheses" className="flex flex-col gap-3">
          {hypPending ? (
            <Skeleton className="h-24 w-full" />
          ) : hypError ? (
            <ApiErrorPanel error={hypErr} />
          ) : hypotheses.length === 0 ? (
            <EmptyPanel text="No hypotheses yet." />
          ) : (
            hypotheses.map((hypothesis) => <HypothesisCard key={hypothesis.id} hypothesis={hypothesis} />)
          )}
        </TabsContent>

        <TabsContent value="findings" className="flex flex-col gap-3">
          {findPending ? (
            <Skeleton className="h-24 w-full" />
          ) : findError ? (
            <ApiErrorPanel error={findErr} />
          ) : findings.length === 0 ? (
            <EmptyPanel
              text={
                terminal
                  ? 'Clean report — no verified findings from this scan.'
                  : 'No verified findings yet — testing is still in progress.'
              }
            />
          ) : (
            findings.map((finding) => <FindingCard key={finding.id} finding={finding} />)
          )}
        </TabsContent>

        <TabsContent value="audit">
          {auditPending ? (
            <Skeleton className="h-24 w-full" />
          ) : auditError ? (
            <ApiErrorPanel error={auditErr} />
          ) : audit.length === 0 ? (
            <EmptyPanel text="No audit entries yet." />
          ) : (
            <div className="flex flex-col">
              {audit
                .slice()
                .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
                .map((entry) => (
                  <div key={entry.id} className="flex items-start gap-4 border-b border-border/60 py-3 text-sm last:border-0">
                    <span className="w-40 shrink-0 font-mono text-xs text-muted-foreground">
                      {formatDateTime(entry.timestamp)}
                    </span>
                    <div className="min-w-0">
                      <p className="font-mono text-xs">{entry.action}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {entry.actor}
                        {entry.detail !== null ? ` — ${entry.detail}` : ''}
                      </p>
                    </div>
                  </div>
                ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel this scan?</DialogTitle>
            <DialogDescription>
              Any in-flight testing stops. This can&apos;t be undone, and the scan moves to Cancelled.
            </DialogDescription>
          </DialogHeader>
          {isApiError(cancelScan.error) ? (
            <Alert variant="destructive">
              <AlertDescription>{apiErrorMessage(cancelScan.error.body, "Couldn't cancel this scan.")}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelOpen(false)}>
              Keep running
            </Button>
            <Button
              variant="destructive"
              disabled={cancelScan.isPending}
              onClick={() => cancelScan.mutate(undefined, { onSuccess: () => setCancelOpen(false) })}
            >
              Cancel scan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EmptyPanel({ text }: { readonly text: string }) {
  return (
    <Card className="border-dashed">
      <CardContent className="py-10 text-center text-sm text-muted-foreground">{text}</CardContent>
    </Card>
  );
}
