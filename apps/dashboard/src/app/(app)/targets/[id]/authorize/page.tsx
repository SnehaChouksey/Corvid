'use client';

import { TbAlertCircle, TbArrowLeft, TbLoader2, TbShieldCheck } from 'react-icons/tb';
import Link from 'next/link';
import { use, useEffect, useRef, useState } from 'react';

import { ApiErrorPanel } from '@/components/api-error';
import { CopyableValue } from '@/components/copyable-value';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { apiErrorMessage, isApiError } from '@/lib/api/client';
import { type AuthorizeResponse } from '@/lib/api/schemas';
import { useAuthorizeTarget, useTarget } from '@/lib/api/targets';
import { formatDateTime } from '@/lib/format';

export default function AuthorizeTargetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: target, isPending: targetPending, isError: targetError, error: targetErr } = useTarget(id);
  const authorize = useAuthorizeTarget(id);
  const firedOnce = useRef(false);
  // Kept in local state (not mutation.data) so the instructions stay on screen while a re-verify
  // is in flight — a mutation's own `data` resets the instant `mutate()` is called again.
  const [result, setResult] = useState<AuthorizeResponse | null>(null);

  function fire() {
    authorize.mutate(undefined, { onSuccess: setResult });
  }

  // Visiting this page IS the challenge/response protocol (D-7): it mints a challenge if none
  // exists yet, or re-checks a previously placed one. There is no separate "get instructions"
  // step to skip, and no click anywhere on this page can fake proof of control.
  useEffect(() => {
    if (!firedOnce.current && target !== undefined && !target.authorized) {
      firedOnce.current = true;
      fire();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <Link
        href={`/targets/${id}`}
        className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <TbArrowLeft className="size-3.5" />
        Target
      </Link>

      {targetPending ? (
        <Skeleton className="h-96 w-full" />
      ) : targetError ? (
        <ApiErrorPanel error={targetErr} notFoundLabel="target" />
      ) : (
        <>
          <div>
            <h1 className="font-display text-3xl tracking-tight">Prove control</h1>
            <p className="mt-1 font-mono text-sm text-muted-foreground">{target.url}</p>
          </div>

          {target.authorized ? (
            <Alert variant="success">
              <TbShieldCheck />
              <AlertTitle>Already authorized</AlertTitle>
              <AlertDescription>
                Authorized by <span className="font-mono">{target.authorizedBy}</span>
                {target.authorizationConfirmedAt !== null ? ` on ${formatDateTime(target.authorizationConfirmedAt)}` : ''}.
              </AlertDescription>
            </Alert>
          ) : result === null ? (
            authorize.isError ? (
              isApiError(authorize.error) && authorize.error.status === 403 ? (
                <Alert variant="destructive">
                  <TbAlertCircle />
                  <AlertTitle>Can&apos;t authorize this host</AlertTitle>
                  <AlertDescription>
                    {apiErrorMessage(
                      authorize.error.body,
                      'This host resolves to disallowed infrastructure (private, loopback, or otherwise dangerous) — Corvid will not run active tests against it.',
                    )}
                  </AlertDescription>
                </Alert>
              ) : (
                <ApiErrorPanel error={authorize.error} />
              )
            ) : (
              <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
                <TbLoader2 className="size-4 animate-spin" />
                Requesting a proof-of-control challenge…
              </div>
            )
          ) : result.status === 'authorized' ? (
            <Alert variant="success">
              <TbShieldCheck />
              <AlertTitle>Authorization confirmed</AlertTitle>
              <AlertDescription>
                Verified via {result.method === 'well_known' ? 'the /.well-known file' : 'DNS TXT record'}. You can
                now start a scan.
              </AlertDescription>
            </Alert>
          ) : (
            <>
              {result.reason !== undefined ? (
                <Alert variant="warning">
                  <TbAlertCircle />
                  <AlertTitle>Not yet satisfied</AlertTitle>
                  <AlertDescription>{result.reason}</AlertDescription>
                </Alert>
              ) : (
                <Alert>
                  <TbShieldCheck />
                  <AlertTitle>Place either proof, then verify</AlertTitle>
                  <AlertDescription>
                    Satisfy exactly one of the two options below on <span className="font-mono">{result.instructions.host}</span>.
                    A bare click can never authorize this target — Corvid checks the record/file itself.
                  </AlertDescription>
                </Alert>
              )}

              {isApiError(authorize.error) ? (
                <Alert variant="destructive">
                  <TbAlertCircle />
                  <AlertTitle>Verification attempt failed</AlertTitle>
                  <AlertDescription>{apiErrorMessage(authorize.error.body, 'Could not check the proof just now — try again.')}</AlertDescription>
                </Alert>
              ) : null}

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Option A — DNS TXT record</CardTitle>
                  <CardDescription>Add this TXT record to your DNS zone.</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <div>
                    <p className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Name</p>
                    <CopyableValue value={result.instructions.dns.name} />
                  </div>
                  <div>
                    <p className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Value</p>
                    <CopyableValue value={result.instructions.dns.value} />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Option B — /.well-known file</CardTitle>
                  <CardDescription>Serve this exact content at the URL below.</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <div>
                    <p className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">URL</p>
                    <CopyableValue value={result.instructions.wellKnown.url} />
                  </div>
                  <div>
                    <p className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">File content</p>
                    <CopyableValue value={result.instructions.wellKnown.expectedContent} />
                  </div>
                </CardContent>
              </Card>

              <Button onClick={fire} disabled={authorize.isPending} className="self-start">
                {authorize.isPending ? <TbLoader2 className="animate-spin" /> : <TbShieldCheck />}
                Verify
              </Button>
            </>
          )}
        </>
      )}
    </div>
  );
}
