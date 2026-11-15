'use client';

import { CheckIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/** How long the popup stays, then how long it takes to fade out. */
const SHOW_MS = 2400;
const FADE_MS = 250;

/**
 * A "saved" popup that pops up in the middle of the screen, above any open dialog, and goes away
 * on its own. It never takes clicks. Rendered into `document.body` (a dialog's transform would
 * pin a fixed child to the dialog instead of the screen). Give it a new `key` to show it again.
 */
export function SavedToast({
  title,
  body,
  onDone,
}: {
  title: string;
  body?: string;
  onDone: () => void;
}) {
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    const fade = setTimeout(() => setLeaving(true), SHOW_MS);
    const done = setTimeout(onDone, SHOW_MS + FADE_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(done);
    };
  }, [onDone]);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center p-6">
      <div
        role="status"
        aria-live="polite"
        style={{ transitionDuration: `${FADE_MS}ms` }}
        className={`flex w-full max-w-xs flex-col items-center gap-3 rounded-3xl border bg-background/95 px-6 py-6 text-center shadow-float backdrop-blur-md transition-[opacity,transform] motion-safe:animate-snap-pop ${
          leaving ? 'scale-95 opacity-0' : 'scale-100 opacity-100'
        }`}
      >
        <span className="grid size-14 place-items-center rounded-full bg-primary text-primary-foreground shadow-card ring-8 ring-primary/15">
          <CheckIcon className="size-8 stroke-[3] motion-safe:animate-snap-pop" aria-hidden />
        </span>
        <div className="grid gap-1">
          <p className="text-base font-semibold">{title}</p>
          {body !== undefined ? <p className="text-sm text-muted-foreground">{body}</p> : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
