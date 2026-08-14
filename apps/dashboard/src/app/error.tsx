'use client';

import { TbAlertCircle } from 'react-icons/tb';

import { CorvidMark } from '@/components/corvid-mark';
import { Button } from '@/components/ui/button';

export default function ErrorBoundary({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <CorvidMark className="text-destructive size-8" />
      <div>
        <h1 className="font-display text-3xl tracking-tight">Something went wrong</h1>
        <p className="mt-1 flex items-center justify-center gap-1.5 text-sm text-muted-foreground">
          <TbAlertCircle className="size-4" />
          The dashboard hit an unexpected error rendering this page.
        </p>
      </div>
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}
