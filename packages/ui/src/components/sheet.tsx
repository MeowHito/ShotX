import { XIcon } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import type * as React from 'react';
import { cn } from '../lib/cn';

/**
 * A panel that slides in from a side: the studio's navigation drawer (left), the details panel
 * (right) and the phone action sheet (bottom).
 */
export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;
export const SheetTitle = DialogPrimitive.Title;
export const SheetDescription = DialogPrimitive.Description;

export function SheetContent({
  className,
  children,
  side = 'left',
  closeLabel,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  side?: 'left' | 'right' | 'bottom';
  /** Accessible name of the close button (translated by the app). */
  closeLabel: string;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 animate-fade-in bg-band/40 backdrop-blur-[2px]" />
      <DialogPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          'fixed z-50 flex flex-col gap-4 overflow-y-auto bg-background p-5 shadow-float outline-none',
          side === 'bottom'
            ? 'inset-x-0 bottom-0 max-h-[85dvh] animate-sheet-bottom rounded-t-3xl border-t pb-[max(1rem,env(safe-area-inset-bottom))]'
            : 'inset-y-0 w-[min(20rem,85vw)]',
          side === 'left' && 'left-0 animate-sheet-left rounded-r-2xl border-r',
          side === 'right' &&
            'right-0 w-[min(24rem,90vw)] animate-sheet-right rounded-l-2xl border-l',
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          className="absolute top-3.5 right-3.5 rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          aria-label={closeLabel}
        >
          <XIcon className="size-5" aria-hidden />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
