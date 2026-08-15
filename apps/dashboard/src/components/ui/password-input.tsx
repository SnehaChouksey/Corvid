'use client';

import { useState } from 'react';
import { TbEye, TbEyeOff } from 'react-icons/tb';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

// Password fields with a show/hide toggle, positioned inside the input's right edge.
export function PasswordInput({
  className,
  ...props
}: Omit<React.ComponentProps<'input'>, 'type'>) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <Input type={visible ? 'text' : 'password'} className={cn('pr-9', className)} {...props} />
      <button
        type="button"
        onClick={() => setVisible((current) => !current)}
        disabled={props.disabled}
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-40"
      >
        {visible ? <TbEyeOff className="size-4" /> : <TbEye className="size-4" />}
      </button>
    </div>
  );
}
