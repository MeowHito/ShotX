'use client';

import { cn } from '@shotx/ui';
import { Maximize2Icon, Minimize2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useSyncExternalStore } from 'react';

/** Safari before 16.4 only has the prefixed API. */
interface WebkitDocument {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
}
interface WebkitElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

const doc = () => document as Document & WebkitDocument;

function fullscreenSupported(): boolean {
  if (typeof document === 'undefined') return false;
  return document.fullscreenEnabled === true || doc().webkitFullscreenEnabled === true;
}

function fullscreenElement(): Element | null {
  return document.fullscreenElement ?? doc().webkitFullscreenElement ?? null;
}

function subscribe(onChange: () => void) {
  document.addEventListener('fullscreenchange', onChange);
  document.addEventListener('webkitfullscreenchange', onChange);
  return () => {
    document.removeEventListener('fullscreenchange', onChange);
    document.removeEventListener('webkitfullscreenchange', onChange);
  };
}

/** Whether the page is shown full screen (the browser's Fullscreen API); false on the server. */
export function useIsFullscreen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => fullscreenElement() !== null,
    () => false,
  );
}

/** Whether this browser can show the page full screen (iPhone Safari can't); false on the server. */
function useFullscreenSupported(): boolean {
  return useSyncExternalStore(
    () => () => undefined,
    fullscreenSupported,
    () => false,
  );
}

async function toggleFullscreen(): Promise<void> {
  try {
    if (fullscreenElement() !== null) {
      await (document.exitFullscreen?.() ?? doc().webkitExitFullscreen?.());
      return;
    }
    const root = document.documentElement as HTMLElement & WebkitElement;
    await (root.requestFullscreen?.({ navigationUI: 'hide' }) ?? root.webkitRequestFullscreen?.());
  } catch {
    // Refused (no user gesture, a policy, an iframe): the page simply stays as it is.
  }
}

/**
 * ADR 0033: a small icon button that shows the page full screen (a monitor at the event: no
 * browser bars, the design fills the screen) and back. Rendered only where the browser supports
 * it, so phones without the API (iPhone) never see a dead button.
 */
export function FullscreenButton({ className }: { className?: string }) {
  const t = useTranslations('common');
  const supported = useFullscreenSupported();
  const active = useIsFullscreen();
  if (!supported) return null;
  const label = active ? t('exitFullscreen') : t('fullscreen');
  return (
    <button
      type="button"
      onClick={() => void toggleFullscreen()}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cn(
        'inline-flex size-9 items-center justify-center rounded-full outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      {active ? (
        <Minimize2Icon className="size-[18px]" aria-hidden />
      ) : (
        <Maximize2Icon className="size-[18px]" aria-hidden />
      )}
    </button>
  );
}
