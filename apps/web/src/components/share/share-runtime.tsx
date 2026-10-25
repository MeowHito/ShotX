'use client';

import { createContext, useContext } from 'react';
import { startBrowserDownload } from '@/lib/downloads/downloads';

/** Browser side effects of the share page, replaceable in tests. */
export interface ShareRuntime {
  startDownload: (url: string, fileName?: string) => void;
  navigator: () => Navigator | undefined;
  fetch: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const defaultShareRuntime: ShareRuntime = {
  startDownload: startBrowserDownload,
  navigator: () => (typeof navigator === 'undefined' ? undefined : navigator),
  fetch: (input, init) => fetch(input, init),
};

export const ShareRuntimeContext = createContext<ShareRuntime>(defaultShareRuntime);

export function useShareRuntime(): ShareRuntime {
  return useContext(ShareRuntimeContext);
}
