import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '../lib/cn';

const alertVariants = cva('relative w-full rounded-xl border px-4 py-3 text-sm', {
  variants: {
    variant: {
      default: 'bg-surface text-foreground',
      warning: 'border-warning/50 bg-warning/10 text-warning-foreground',
      destructive: 'border-destructive/40 bg-destructive/5 text-destructive',
    },
  },
  defaultVariants: { variant: 'default' },
});

export function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return <div role="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}
