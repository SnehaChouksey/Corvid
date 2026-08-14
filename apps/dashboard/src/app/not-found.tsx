import Link from 'next/link';

import { CorvidMark } from '@/components/corvid-mark';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <CorvidMark className="text-muted-foreground size-8" />
      <div>
        <h1 className="font-display text-3xl tracking-tight">Not found</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          This page doesn&apos;t exist, or you don&apos;t have access to it.
        </p>
      </div>
      <Button asChild>
        <Link href="/targets">Back to targets</Link>
      </Button>
    </div>
  );
}
