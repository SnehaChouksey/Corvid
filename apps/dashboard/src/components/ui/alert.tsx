import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

export const alertVariants = cva('relative w-full rounded-lg border px-4 py-3 text-sm [&>svg]:size-4', {
  variants: {
    variant: {
      default: 'border-border bg-card text-card-foreground [&>svg]:text-muted-foreground',
      destructive: 'border-destructive/30 bg-destructive/10 text-destructive [&>svg]:text-destructive',
      warning: 'border-warning/30 bg-warning/10 text-warning [&>svg]:text-warning',
      success: 'border-success/30 bg-success/10 text-success [&>svg]:text-success',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
});

export interface AlertProps extends React.ComponentProps<'div'>, VariantProps<typeof alertVariants> {}

export function Alert({ className, variant, ...props }: AlertProps) {
  return <div data-slot="alert" role="alert" className={cn(alertVariants({ variant, className }))} {...props} />;
}

export function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="alert-title" className={cn('mb-1 font-medium leading-none tracking-tight', className)} {...props} />;
}

export function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-description"
      className={cn('text-sm text-muted-foreground [&_p]:leading-relaxed', className)}
      {...props}
    />
  );
}
