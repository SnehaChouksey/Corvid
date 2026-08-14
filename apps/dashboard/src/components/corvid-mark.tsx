import { cn } from '@/lib/utils';

/**
 * The Corvid glyph — an eight-point scan/signal mark (radar sweep meets compass rose), not a
 * literal bird. It's the one recurring shape in the product: the sidebar mark, the sign-in seal,
 * and the pulsing "live" indicator all derive from the same idea — a fixed point, actively
 * watching in every direction.
 */
export function CorvidMark({ className }: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="currentColor" className={cn('size-5', className)} aria-hidden>
      <path d="M16 2 L18.4 12.4 L28 9.5 L20.4 16.6 L27 24.9 L17.4 20.2 L16 30 L14.6 20.2 L5 24.9 L11.6 16.6 L4 9.5 L13.6 12.4 Z" />
    </svg>
  );
}
