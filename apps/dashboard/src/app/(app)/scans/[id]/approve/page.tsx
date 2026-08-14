'use client';

import { TbAlertCircle, TbArrowLeft, TbShieldExclamation } from 'react-icons/tb';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { ApiErrorPanel } from '@/components/api-error';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { apiErrorMessage, isApiError } from '@/lib/api/client';
import { useHypotheses, useScan, useSubmitApproval } from '@/lib/api/scans';
import { VULN_CLASS_LABEL } from '@/lib/status';

export default function ApprovalGatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { data: scan, isPending: scanPending, isError: scanErrored, error: scanErr } = useScan(id);
  const { data: hypotheses, isPending: hypPending, isError: hypErrored, error: hypErr } = useHypotheses(id);
  const submitApproval = useSubmitApproval(id);

  // Nothing pre-approved, ever (CODING_STANDARDS §10 / `01` §6) — this Set starts empty every
  // render of a fresh gate and is only ever populated by an explicit click.
  const [approvedIds, setApprovedIds] = useState<ReadonlySet<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);

  const pendingHypotheses = useMemo(() => (hypotheses ?? []).filter((h) => h.status === 'pending'), [hypotheses]);

  function toggle(hypothesisId: string) {
    setApprovedIds((prev) => {
      const next = new Set(prev);
      if (next.has(hypothesisId)) {
        next.delete(hypothesisId);
      } else {
        next.add(hypothesisId);
      }
      return next;
    });
  }

  function handleSubmit() {
    submitApproval.mutate(Array.from(approvedIds), {
      onSuccess: (result) => {
        toast.success(
          result.approved.length === 0
            ? 'Submitted — nothing approved for testing.'
            : `Submitted — ${result.approved.length} hypothesis${result.approved.length === 1 ? '' : 'es'} queued for testing.`,
        );
        setConfirmOpen(false);
        router.push(`/scans/${id}`);
      },
      onError: () => setConfirmOpen(false),
    });
  }

  if (scanPending || hypPending) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-9 w-96" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (scanErrored) {
    return <ApiErrorPanel error={scanErr} notFoundLabel="scan" />;
  }
  if (hypErrored) {
    return <ApiErrorPanel error={hypErr} />;
  }

  if (scan.status !== 'awaiting_approval') {
    return (
      <div className="flex max-w-2xl flex-col gap-6">
        <Link href={`/scans/${id}`} className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <TbArrowLeft className="size-3.5" />
          Scan
        </Link>
        <Alert variant="warning">
          <TbAlertCircle />
          <AlertTitle>This scan isn&apos;t awaiting approval</AlertTitle>
          <AlertDescription>
            Its status is now &ldquo;{scan.status}&rdquo; — the gate has already been acted on, or the scan
            moved past it.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const rejectedCount = pendingHypotheses.length - approvedIds.size;

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <Link href={`/scans/${id}`} className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <TbArrowLeft className="size-3.5" />
        Scan
      </Link>

      <div>
        <h1 className="font-display text-3xl tracking-tight">Approval gate</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Nothing here is pre-approved. Check exactly what you want tested — everything else is rejected.
        </p>
      </div>

      {pendingHypotheses.length === 0 ? (
        <Alert>
          <AlertTitle>No hypotheses to review</AlertTitle>
          <AlertDescription>There&apos;s nothing pending a decision right now.</AlertDescription>
        </Alert>
      ) : (
        <>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <button
              type="button"
              className="cursor-pointer underline underline-offset-2 hover:text-foreground"
              onClick={() => setApprovedIds(new Set(pendingHypotheses.map((h) => h.id)))}
            >
              Select all
            </button>
            <span>·</span>
            <button
              type="button"
              className="cursor-pointer underline underline-offset-2 hover:text-foreground"
              onClick={() => setApprovedIds(new Set())}
            >
              Select none
            </button>
          </div>

          <div className="flex flex-col gap-3">
            {pendingHypotheses.map((hypothesis) => {
              const checked = approvedIds.has(hypothesis.id);
              return (
                <Card
                  key={hypothesis.id}
                  className={checked ? 'border-primary/50 bg-primary/[0.03]' : undefined}
                >
                  <CardContent className="flex gap-3 py-4">
                    <Checkbox
                      className="mt-0.5"
                      checked={checked}
                      onCheckedChange={() => toggle(hypothesis.id)}
                      aria-label={`Approve testing ${hypothesis.vulnClass} on ${hypothesis.endpoint}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] tracking-wide text-muted-foreground uppercase">
                          {VULN_CLASS_LABEL[hypothesis.vulnClass]}
                        </span>
                        <span className="truncate font-mono text-sm">{hypothesis.endpoint}</span>
                      </div>
                      <p className="mt-1.5 text-sm text-muted-foreground">{hypothesis.rationale}</p>
                      {hypothesis.plan !== null ? (
                        <div className="mt-2 rounded-md border border-border/60 bg-muted/40 px-3 py-2 font-mono text-xs">
                          <span className="text-muted-foreground">
                            intended: {hypothesis.plan.tool ?? hypothesis.plan.payloadFamily}
                          </span>
                          {hypothesis.plan.intendedPayload !== undefined ? (
                            <div className="mt-1 overflow-x-auto text-foreground">{hypothesis.plan.intendedPayload}</div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {isApiError(submitApproval.error) ? (
            submitApproval.error.status === 409 || submitApproval.error.status === 400 ? (
              <Alert variant="destructive">
                <TbAlertCircle />
                <AlertTitle>Couldn&apos;t submit your decision</AlertTitle>
                <AlertDescription>
                  {submitApproval.error.status === 409
                    ? 'This scan is no longer awaiting approval — someone or something already acted on this gate.'
                    : apiErrorMessage(
                        submitApproval.error.body,
                        'One or more hypotheses are no longer valid — refresh and try again.',
                      )}
                </AlertDescription>
              </Alert>
            ) : (
              <ApiErrorPanel error={submitApproval.error} />
            )
          ) : null}

          <div className="sticky bottom-6 flex justify-end">
            <Button size="lg" onClick={() => setConfirmOpen(true)}>
              <TbShieldExclamation />
              Review and submit ({approvedIds.size} approved)
            </Button>
          </div>
        </>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Confirm exactly what will be tested</DialogTitle>
            <DialogDescription>
              Live payloads will be sent to the target for the approved hypotheses only, the moment you confirm.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3 text-sm">
            {approvedIds.size === 0 ? (
              <p className="text-muted-foreground">
                You are approving <span className="font-medium text-foreground">nothing</span>. No active testing
                will run from this batch.
              </p>
            ) : (
              <div>
                <p className="mb-1.5 font-medium text-foreground">
                  {approvedIds.size} approved — will be tested now:
                </p>
                <ul className="flex flex-col gap-1">
                  {pendingHypotheses
                    .filter((h) => approvedIds.has(h.id))
                    .map((h) => (
                      <li key={h.id} className="font-mono text-xs text-muted-foreground">
                        {VULN_CLASS_LABEL[h.vulnClass]} · {h.endpoint}
                      </li>
                    ))}
                </ul>
              </div>
            )}
            {rejectedCount > 0 ? (
              <p className="text-muted-foreground">{rejectedCount} rejected — will not be tested.</p>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Go back
            </Button>
            <Button onClick={handleSubmit} disabled={submitApproval.isPending}>
              Confirm and submit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
