'use client';

import { TbAlertTriangle, TbArrowLeft, TbPlayerPlay } from 'react-icons/tb';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { toast } from 'sonner';

import { ApiErrorPanel } from '@/components/api-error';
import {
  CredentialsFields,
  type CredentialsFormState,
  initialCredentialsFormState,
} from '@/components/scans/credentials-fields';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { apiErrorMessage, isApiError } from '@/lib/api/client';
import { useCreateScan } from '@/lib/api/scans';
import { useTargets } from '@/lib/api/targets';
import { credentialsFromFormState } from '@/lib/headers';

export default function NewScanPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full max-w-2xl" />}>
      <NewScanForm />
    </Suspense>
  );
}

function NewScanForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { data: targets, isPending: targetsPending, isError: targetsErrored, error: targetsError } = useTargets();
  const createScan = useCreateScan();

  const [targetId, setTargetId] = useState(searchParams.get('targetId') ?? '');
  const [credentialsState, setCredentialsState] = useState<CredentialsFormState>(initialCredentialsFormState);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const selectedTarget = targets?.find((target) => target.id === targetId);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (targetId.length === 0) {
      setErrorMessage('Choose a target.');
      return;
    }
    setErrorMessage(null);
    const credentials = credentialsFromFormState(credentialsState);
    createScan.mutate(
      { targetId, ...(credentials !== undefined ? { credentials } : {}) },
      {
        onSuccess: ({ id }) => {
          toast.success('Scan started.');
          router.push(`/scans/${id}`);
        },
        onError: (err) => {
          if (isApiError(err) && err.status === 403) {
            setErrorMessage(apiErrorMessage(err.body, 'This target is not authorized for scanning.'));
            return;
          }
          if (isApiError(err) && err.status === 400) {
            setErrorMessage(apiErrorMessage(err.body, 'Invalid credentials — check the fields and try again.'));
            return;
          }
          setErrorMessage(null); // 429 concurrent-cap is rendered via ApiErrorPanel below instead
        },
      },
    );
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <Link href="/targets" className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <TbArrowLeft className="size-3.5" />
        Targets
      </Link>

      <div>
        <h1 className="font-display text-3xl tracking-tight">New scan</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Corvid will crawl, hypothesize, and pause at the approval gate — nothing is tested until you approve it.
        </p>
      </div>

      {createScan.isError && isApiError(createScan.error) && createScan.error.status === 429 ? (
        <ApiErrorPanel error={createScan.error} />
      ) : null}

      <form className="flex flex-col gap-5" onSubmit={handleSubmit}>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Target</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {targetsPending ? (
              <Skeleton className="h-9 w-full" />
            ) : targetsErrored ? (
              <ApiErrorPanel error={targetsError} notFoundLabel="targets" />
            ) : targets.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                You have no targets yet.{' '}
                <Link href="/targets/new" className="text-primary underline">
                  Add one
                </Link>
                .
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="target">Target</Label>
                <Select value={targetId} onValueChange={setTargetId}>
                  <SelectTrigger id="target">
                    <SelectValue placeholder="Choose a target" />
                  </SelectTrigger>
                  <SelectContent>
                    {targets.map((target) => (
                      <SelectItem key={target.id} value={target.id}>
                        {target.url} {target.authorized ? '' : '— unauthorized'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {selectedTarget !== undefined && !selectedTarget.authorized ? (
              <Alert variant="warning">
                <TbAlertTriangle />
                <AlertTitle>Authorization not recorded for this scope</AlertTitle>
                <AlertDescription>
                  This target must be authorized before Corvid can scan it.{' '}
                  <Link href={`/targets/${selectedTarget.id}/authorize`} className="underline">
                    Authorize it
                  </Link>
                  , then come back here.
                </AlertDescription>
              </Alert>
            ) : null}
          </CardContent>
        </Card>

        <div>
          <h2 className="mb-3 text-sm font-medium tracking-wide text-muted-foreground uppercase">Credentials</h2>
          <CredentialsFields state={credentialsState} onChange={setCredentialsState} />
        </div>

        {errorMessage !== null ? (
          <Alert variant="destructive">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        <Button
          type="submit"
          disabled={createScan.isPending || targetId.length === 0 || selectedTarget?.authorized === false}
          className="self-start"
        >
          <TbPlayerPlay />
          Start scan
        </Button>
      </form>
    </div>
  );
}
