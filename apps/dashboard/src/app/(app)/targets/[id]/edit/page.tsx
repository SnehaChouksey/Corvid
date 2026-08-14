'use client';

import { TbArrowLeft } from 'react-icons/tb';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useState } from 'react';
import { toast } from 'sonner';

import { ApiErrorPanel } from '@/components/api-error';
import { TargetScopeForm, type TargetScopeFormValues } from '@/components/targets/target-scope-form';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { type ApiError, apiErrorMessage, isApiError } from '@/lib/api/client';
import { useTarget, useUpdateTarget } from '@/lib/api/targets';

export default function EditTargetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: target, isPending, isError, error } = useTarget(id);
  const updateTarget = useUpdateTarget(id);
  const router = useRouter();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [rateLimitError, setRateLimitError] = useState<ApiError | null>(null);

  function handleSubmit(values: TargetScopeFormValues) {
    setErrorMessage(null);
    setRateLimitError(null);
    updateTarget.mutate(values, {
      onSuccess: (updated) => {
        toast.success(updated.authorized ? 'Target updated.' : 'Target updated — authorization was invalidated.');
        router.push(`/targets/${id}`);
      },
      onError: (err) => {
        if (!isApiError(err)) {
          setErrorMessage('Could not save this target.');
          return;
        }
        if (err.status === 429) {
          setRateLimitError(err);
          return;
        }
        if (err.status === 403) {
          setErrorMessage(
            apiErrorMessage(
              err.body,
              "This scope can't be accepted — check for private, loopback, or otherwise disallowed hosts.",
            ),
          );
          return;
        }
        setErrorMessage(apiErrorMessage(err.body, 'Could not save this target.'));
      },
    });
  }

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <Link
        href={`/targets/${id}`}
        className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <TbArrowLeft className="size-3.5" />
        Target
      </Link>

      {isPending ? (
        <Skeleton className="h-96 w-full" />
      ) : isError ? (
        <ApiErrorPanel error={error} notFoundLabel="target" />
      ) : (
        <>
          <div>
            <h1 className="font-display text-3xl tracking-tight">Edit target</h1>
          </div>
          {rateLimitError !== null ? <ApiErrorPanel error={rateLimitError} /> : null}
          <Card>
            <CardContent className="pt-5">
              <TargetScopeForm
                mode="edit"
                initialUrl={target.url}
                initialScopeRules={target.scopeRules}
                currentlyAuthorized={target.authorized}
                submitting={updateTarget.isPending}
                errorMessage={errorMessage}
                onSubmit={handleSubmit}
              />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
