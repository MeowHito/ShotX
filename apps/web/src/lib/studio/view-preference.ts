'use client';

import { useCallback, useSyncExternalStore } from 'react';
import type { ItemLayout } from '@/components/drive/item-card';

/** Grid or list, remembered on this device (a display preference only; nothing personal). */
const KEY = 'shotx.studio.layout';
const EVENT = 'shotx-layout-change';

function read(): ItemLayout {
  try {
    return window.localStorage.getItem(KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener('storage', onChange);
  window.addEventListener(EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(EVENT, onChange);
  };
}

export function useLayoutPreference(): [ItemLayout, (layout: ItemLayout) => void] {
  const layout = useSyncExternalStore(subscribe, read, () => 'grid' as const);
  const set = useCallback((next: ItemLayout) => {
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      // Private mode: the choice lasts until reload.
    }
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return [layout, set];
}
