'use client';

import { TbCheck, TbCopy } from 'react-icons/tb';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function CopyableValue({ value, className }: { readonly value: string; readonly className?: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className={cn('flex items-center gap-2 rounded-md border border-border bg-muted/60 px-3 py-2', className)}>
      <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-pre text-foreground">{value}</code>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-6 shrink-0"
        onClick={() => void handleCopy()}
        aria-label="Copy to clipboard"
      >
        {copied ? <TbCheck className="text-success" /> : <TbCopy />}
      </Button>
    </div>
  );
}
