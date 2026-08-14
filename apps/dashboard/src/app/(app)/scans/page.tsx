'use client';

import { TbRadar } from 'react-icons/tb';
import Link from 'next/link';

import { ApiErrorPanel } from '@/components/api-error';
import { ScanStatusBadge } from '@/components/status-badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useFindings, useScans } from '@/lib/api/scans';
import { formatDateTime } from '@/lib/format';

function FindingsCount({ scanId }: { readonly scanId: string }) {
  const { data: findings } = useFindings(scanId);
  if (findings === undefined) {
    return <Skeleton className="h-4 w-16" />;
  }
  return (
    <span className="text-xs text-muted-foreground">
      {findings.length} {findings.length === 1 ? 'finding' : 'findings'}
    </span>
  );
}

export default function ScansPage() {
  const { data: scans, isPending, isError, error } = useScans();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-display text-3xl tracking-tight">Scans</h1>
        <p className="mt-1 text-sm text-muted-foreground">Every scan you&apos;ve run, across all targets.</p>
      </div>

      {isPending ? (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : isError ? (
        <ApiErrorPanel error={error} notFoundLabel="scans" />
      ) : scans.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
            <TbRadar className="size-8 text-muted-foreground" />
            <div>
              <p className="font-medium">No scans yet</p>
              <p className="mt-1 text-sm text-muted-foreground">Start one from an authorized target.</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {scans
            .slice()
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
            .map((scan) => (
              <Link key={scan.id} href={`/scans/${scan.id}`}>
                <Card className="transition-colors hover:border-border">
                  <CardContent className="flex items-center justify-between py-4">
                    <div className="min-w-0">
                      <p className="font-mono text-xs text-muted-foreground">{scan.id}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{formatDateTime(scan.createdAt)}</p>
                    </div>
                    <div className="flex items-center gap-4">
                      <FindingsCount scanId={scan.id} />
                      <ScanStatusBadge status={scan.status} />
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
        </div>
      )}
    </div>
  );
}
