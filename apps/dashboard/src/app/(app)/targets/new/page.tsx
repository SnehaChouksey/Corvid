'use client';

import { TbArrowLeft } from 'react-icons/tb';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { ApiErrorPanel } from '@/components/api-error';
import { TargetScopeForm, type TargetScopeFormValues } from '@/components/targets/target-scope-form';
import { Card, CardContent } from '@/components/ui/card';
import { type ApiError, apiErrorMessage, isApiError } from '@/lib/api/client';
import { useCreateTarget } from '@/lib/api/targets';

export default function NewTargetPage() {
  const router = useRouter();
  const createTarget = useCreateTarget();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [rateLimitError, setRateLimitError] = useState<ApiError | null>(null);

  function handleSubmit(values: TargetScopeFormValues) {
    setErrorMessage(null);
    setRateLimitError(null);
    createTarget.mutate(values, {
      onSuccess: ({ id }) => {
        toast.success('Target added — it starts Unauthorized.');
        router.push(`/targets/${id}/authorize`);
      },
      onError: (err) => {
        if (!isApiError(err)) {
          setErrorMessage('Could not add this target.');
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
        setErrorMessage(apiErrorMessage(err.body, 'Could not add this target.'));
      },
    });
  }

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <div>
        <Link href="/targets" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <TbArrowLeft className="size-3.5" />
          Targets
        </Link>
        <h1 className="font-display text-3xl tracking-tight">Add target</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A new target starts Unauthorized — you&apos;ll prove control before any scan can run.
        </p>
      </div>

      {rateLimitError !== null ? <ApiErrorPanel error={rateLimitError} /> : null}

      <Card>
        <CardContent className="pt-5">
          <TargetScopeForm
            mode="create"
            submitting={createTarget.isPending}
            errorMessage={errorMessage}
            onSubmit={handleSubmit}
          />
        </CardContent>
      </Card>
    </div>
  );
}
