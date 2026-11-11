'use client';

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { DriveFile } from '@shotx/shared';
import type { ClientStudioConfig } from '@/lib/server/config';
import { isApplePlatform, matches, shouldIgnoreKey } from '@/lib/studio/shortcuts';
import { ShortcutsDialog } from './shortcuts-dialog';

/**
 * Studio-wide state shared by the shell (top bar, aside) and the page content:
 * - the folder the page shows (the "+ New" (studio.new) menu creates and uploads there, search can scope
 *   to it); null at the drive root and on pages without a folder;
 * - commands other parts register (new folder, upload, focus search) so the global shortcuts can
 *   run them;
 * - the platform (⌘ or Ctrl) for shortcut hints.
 */

export type StudioCommand = 'newFolder' | 'uploadFiles' | 'uploadFolder' | 'focusSearch';

/** Defaults where no config is passed (tests, components rendered on their own). */
export const DEFAULT_STUDIO_CONFIG: ClientStudioConfig = {
  processingPollMs: 3000,
  zipPollIntervalMs: 2000,
  zipPollTimeoutMs: 15 * 60_000,
  // BILLING_MODE's default (ADR 0010).
  billingMode: 'offline',
  viewerLoginAvailable: true,
};

interface StudioContextValue {
  currentFolderId: string | null;
  setCurrentFolder: (folderId: string | null) => void;
  config: ClientStudioConfig;
  /** Files remembered by ⌘C / Ctrl+C, pasted as copies with ⌘V / Ctrl+V in any folder. */
  clipboard: readonly DriveFile[];
  setClipboard: (files: readonly DriveFile[]) => void;
  apple: boolean;
  register: (commands: Partial<Record<StudioCommand, () => void>>) => () => void;
  run: (command: StudioCommand) => boolean;
  showShortcuts: () => void;
}

const NOOP_CONTEXT: StudioContextValue = {
  currentFolderId: null,
  setCurrentFolder: () => undefined,
  config: DEFAULT_STUDIO_CONFIG,
  clipboard: [],
  setClipboard: () => undefined,
  apple: false,
  register: () => () => undefined,
  run: () => false,
  showShortcuts: () => undefined,
};

const StudioContext = createContext<StudioContextValue | null>(null);

/** The studio context; a no-op outside <StudioProvider> (components rendered on their own). */
export function useStudio(): StudioContextValue {
  return useContext(StudioContext) ?? NOOP_CONTEXT;
}

const subscribeNothing = () => () => undefined;

/** ⌘ on Mac and iPadOS, Ctrl elsewhere. False during SSR, then the real value. */
export function useApplePlatform(nav?: Navigator): boolean {
  return useSyncExternalStore(
    subscribeNothing,
    () => isApplePlatform(nav ?? (typeof navigator === 'undefined' ? undefined : navigator)),
    () => false,
  );
}

/** Matches a CSS media query (false during SSR and where matchMedia is missing). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return () => undefined;
      }
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia(query).matches,
    () => false,
  );
}

/** Phones (below Tailwind `sm`): menus become bottom sheets, selection gets a bottom bar. */
export const PHONE_QUERY = '(max-width: 639px)';

export function StudioProvider({
  children,
  nav,
  config = DEFAULT_STUDIO_CONFIG,
}: {
  children: ReactNode;
  nav?: Navigator;
  config?: ClientStudioConfig;
}) {
  const apple = useApplePlatform(nav);
  const [currentFolderId, setCurrentFolder] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<readonly DriveFile[]>([]);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const commands = useRef(new Map<StudioCommand, () => void>());

  const register = useCallback((next: Partial<Record<StudioCommand, () => void>>) => {
    const entries = Object.entries(next) as [StudioCommand, () => void][];
    for (const [name, fn] of entries) commands.current.set(name, fn);
    return () => {
      for (const [name, fn] of entries) {
        if (commands.current.get(name) === fn) commands.current.delete(name);
      }
    };
  }, []);

  const run = useCallback((command: StudioCommand) => {
    const fn = commands.current.get(command);
    if (fn === undefined) return false;
    fn();
    return true;
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || shouldIgnoreKey(event)) return;
      const command: StudioCommand | 'help' | null = matches('search', event, apple)
        ? 'focusSearch'
        : matches('help', event, apple)
          ? 'help'
          : matches('newFolder', event, apple)
            ? 'newFolder'
            : matches('upload', event, apple)
              ? 'uploadFiles'
              : null;
      if (command === null) return;
      if (command === 'help') {
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (run(command)) event.preventDefault();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [apple, run]);

  const value = useMemo<StudioContextValue>(
    () => ({
      currentFolderId,
      setCurrentFolder,
      config,
      clipboard,
      setClipboard,
      apple,
      register,
      run,
      showShortcuts: () => setShortcutsOpen(true),
    }),
    [currentFolderId, config, clipboard, apple, register, run],
  );

  return (
    <StudioContext.Provider value={value}>
      {children}
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} apple={apple} />
    </StudioContext.Provider>
  );
}
