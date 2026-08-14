'use client';

import { TbCrosshair, TbPlus } from 'react-icons/tb';
import Link from 'next/link';

import { ApiErrorPanel } from '@/components/api-error';
import { AuthorizationBadge } from '@/components/targets/authorization-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useTargets } from '@/lib/api/targets';

export default function TargetsPage() {
  const { data: targets, isPending, isError, error } = useTargets();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-3xl tracking-tight">Targets</h1>
          <p className="mt-1 text-sm text-muted-foreground">Every target you&apos;ve added, with its authorization state.</p>
        </div>
        <Button asChild>
          <Link href="/targets/new">
            <TbPlus />
            Add target
          </Link>
        </Button>
      </div>

      {isPending ? (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : isError ? (
        <ApiErrorPanel error={error} notFoundLabel="targets" />
      ) : targets.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
            <TbCrosshair className="size-8 text-muted-foreground" />
            <div>
              <p className="font-medium">No targets yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Add a target and prove control before Corvid will run a single test against it.
              </p>
            </div>
            <Button asChild className="mt-2">
              <Link href="/targets/new">
                <TbPlus />
                Add your first target
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {targets.map((target) => (
            <Card key={target.id} className="transition-colors hover:border-border">
              <CardContent className="flex flex-col gap-3 py-4">
                <div className="flex items-center justify-between gap-6">
                  <Link href={`/targets/${target.id}`} className="min-w-0 flex-1">
                    <p className="truncate font-mono text-sm text-foreground">{target.url}</p>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {target.scopeRules.hosts.join(', ')}
                    </p>
                  </Link>
                  <div className="flex shrink-0 items-center gap-3">
                    <AuthorizationBadge authorized={target.authorized} />
                    {target.authorized ? (
                      <Button asChild size="sm">
                        <Link href={`/scans/new?targetId=${target.id}`}>Start scan</Link>
                      </Button>
                    ) : (
                      <Button size="sm" disabled>
                        Start scan
                      </Button>
                    )}
                  </div>
                </div>
                {!target.authorized ? (
                  <p className="text-xs text-muted-foreground">
                    Authorization not recorded for this scope —{' '}
                    <Link href={`/targets/${target.id}/authorize`} className="text-primary underline underline-offset-2">
                      authorize it
                    </Link>{' '}
                    before you can scan.
                  </p>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
