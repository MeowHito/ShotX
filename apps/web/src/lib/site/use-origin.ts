'use client';

import { useSyncExternalStore } from 'react';

/** This page's origin (`https://snap.action.in.th`); null on the server and in the first paint. */
export function useOrigin(): string | null {
  return useSyncExternalStore(
    () => () => undefined,
    () => window.location.origin,
    () => null,
  );
}
