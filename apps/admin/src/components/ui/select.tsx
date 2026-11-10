import { cn } from '@shotx/ui';
import type * as React from 'react';

/** A native select styled like @shotx/ui's Input (accessible and keyboard-friendly as is). */
export function NativeSelect({ className, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'flex h-10 w-full rounded-lg border border-input bg-background px-3 py-2 text-base transition-[border-color,box-shadow] duration-150 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
        className,
      )}
      {...props}
    />
  );
}
