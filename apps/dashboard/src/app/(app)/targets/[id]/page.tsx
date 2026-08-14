'use client';

import { TbArrowLeft, TbPencil, TbPlayerPlay, TbShieldCheck } from 'react-icons/tb';
import Link from 'next/link';
import { use } from 'react';

import { ApiErrorPanel } from '@/components/api-error';
import { AuthorizationBadge } from '@/components/targets/authorization-badge';
import { ScanStatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { useTarget } from '@/lib/api/targets';
import { useScans } from '@/lib/api/scans';
import { formatDateTime } from '@/lib/format';

export default function TargetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: target, isPending, isError, error } = useTarget(id);
  const { data: allScans } = useScans();
  const scans = allScans?.filter((scan) => scan.targetId === id) ?? [];

  return (
    <div className="flex flex-col gap-6">
      <Link href="/targets" className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <TbArrowLeft className="size-3.5" />
        Targets
      </Link>

      {isPending ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-9 w-96" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : isError ? (
        <ApiErrorPanel error={error} notFoundLabel="target" />
      ) : (
        <>
          <div className="flex items-start justify-between gap-6">
            <div className="min-w-0">
              <h1 className="truncate font-mono text-2xl tracking-tight text-foreground">{target.url}</h1>
              <p className="mt-2 text-xs text-muted-foreground">Added {formatDateTime(target.createdAt)}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button asChild variant="outline" size="sm">
                <Link href={`/targets/${id}/edit`}>
                  <TbPencil />
                  Edit
                </Link>
              </Button>
              {target.authorized ? (
                <Button asChild size="sm">
                  <Link href={`/scans/new?targetId=${id}`}>
                    <TbPlayerPlay />
                    Start scan
                  </Link>
                </Button>
              ) : (
                <Button asChild size="sm">
                  <Link href={`/targets/${id}/authorize`}>
                    <TbShieldCheck />
                    Authorize
                  </Link>
                </Button>
              )}
            </div>
          </div>

          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle className="text-base">Scope</CardTitle>
              <AuthorizationBadge authorized={target.authorized} />
            </CardHeader>
            <CardContent className="flex flex-col gap-4 text-sm">
              <div>
                <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Hosts</p>
                <p className="mt-1 font-mono">{target.scopeRules.hosts.join(', ')}</p>
              </div>
              {target.scopeRules.includePaths !== undefined && target.scopeRules.includePaths.length > 0 ? (
                <div>
                  <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Include paths</p>
                  <p className="mt-1 font-mono">{target.scopeRules.includePaths.join(', ')}</p>
                </div>
              ) : null}
              {target.scopeRules.excludePaths !== undefined && target.scopeRules.excludePaths.length > 0 ? (
                <div>
                  <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Exclude paths</p>
                  <p className="mt-1 font-mono">{target.scopeRules.excludePaths.join(', ')}</p>
                </div>
              ) : null}
              <Separator />
              {target.authorized ? (
                <p className="text-xs text-muted-foreground">
                  Authorized by <span className="font-mono text-foreground">{target.authorizedBy}</span>
                  {target.authorizationConfirmedAt !== null
                    ? ` on ${formatDateTime(target.authorizationConfirmedAt)}`
                    : ''}
                  .
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Not yet authorized — proof of control is required before any scan can start.
                </p>
              )}
            </CardContent>
          </Card>

          <div>
            <h2 className="mb-3 text-sm font-medium tracking-wide text-muted-foreground uppercase">Scan history</h2>
            {scans.length === 0 ? (
              <Card className="border-dashed">
                <CardContent className="py-8 text-center text-sm text-muted-foreground">
                  No scans have run against this target yet.
                </CardContent>
              </Card>
            ) : (
              <div className="flex flex-col gap-2">
                {scans.map((scan) => (
                  <Link key={scan.id} href={`/scans/${scan.id}`}>
                    <Card className="transition-colors hover:border-border">
                      <CardContent className="flex items-center justify-between py-3">
                        <span className="font-mono text-xs text-muted-foreground">{scan.id}</span>
                        <div className="flex items-center gap-4">
                          <span className="text-xs text-muted-foreground">{formatDateTime(scan.createdAt)}</span>
                          <ScanStatusBadge status={scan.status} />
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
