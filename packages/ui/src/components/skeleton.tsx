import type * as React from 'react';
import { cn } from '../lib/cn';

/** A placeholder block shown while content loads (respects reduced motion). */
export function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      aria-hidden
      className={cn('animate-pulse rounded-md bg-muted motion-reduce:animate-none', className)}
      {...props}
    />
  );
}
