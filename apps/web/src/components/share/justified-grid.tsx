'use client';

import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { aspectRatio, justifiedRows, type Sized, targetRowHeight } from '@/lib/share/justified';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

function useBox(ref: React.RefObject<HTMLElement | null>): { width: number; top: number } {
  const [box, setBox] = useState({ width: 0, top: 0 });
  useIsomorphicLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const measure = () => {
      const width = element.clientWidth || window.innerWidth;
      const top = element.getBoundingClientRect().top + window.scrollY;
      setBox((prev) => (prev.width === width && prev.top === top ? prev : { width, top }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return box;
}

export interface JustifiedGridProps<T extends Sized & { id: string }> {
  items: readonly T[];
  renderItem: (item: T, size: { width: number; height: number }) => ReactNode;
  label: string;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  fetchNextPage?: () => unknown;
  loadingMoreLabel?: string;
  gapPx?: number;
  /** Room under each photo (the "not me" button of results). */
  captionPx?: number;
}

/**
 * The share page's photo grid: justified rows in the photos' own aspect ratios (justifiedRows),
 * virtualized with TanStack Virtual (window scrolling, only visible rows in the DOM), loading the
 * next cursor page as the user nears the end.
 */
export function JustifiedGrid<T extends Sized & { id: string }>({
  items,
  renderItem,
  label,
  hasNextPage = false,
  isFetchingNextPage = false,
  fetchNextPage,
  loadingMoreLabel,
  gapPx = 4,
  captionPx = 0,
}: JustifiedGridProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { width: measured, top } = useBox(containerRef);
  const width = measured || 360;
  const rows = useMemo(
    () => justifiedRows(items.map(aspectRatio), width, targetRowHeight(width), gapPx),
    [items, width, gapPx],
  );

  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: (i) => (rows[i]?.height ?? 0) + captionPx + gapPx,
    overscan: 4,
    scrollMargin: top,
  });
  useEffect(() => {
    virtualizer.measure();
  }, [rows, virtualizer]);

  const virtualRows = virtualizer.getVirtualItems();
  const lastRow = virtualRows.at(-1)?.index ?? -1;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && lastRow >= rows.length - 3) void fetchNextPage?.();
  }, [hasNextPage, isFetchingNextPage, lastRow, rows.length, fetchNextPage]);

  return (
    <div ref={containerRef}>
      <div
        role="list"
        aria-label={label}
        aria-busy={isFetchingNextPage}
        style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}
      >
        {virtualRows.map((virtual) => {
          const row = rows[virtual.index];
          if (row === undefined) return null;
          return (
            <div
              key={virtual.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtual.start - virtualizer.options.scrollMargin}px)`,
                display: 'flex',
                gap: gapPx,
              }}
            >
              {row.widths.map((itemWidth, i) => {
                const item = items[row.start + i];
                if (item === undefined) return null;
                const size = { width: itemWidth, height: row.height };
                return (
                  <div
                    role="listitem"
                    key={item.id}
                    className="shrink-0"
                    style={{ width: itemWidth }}
                  >
                    {renderItem(item, size)}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {isFetchingNextPage && loadingMoreLabel !== undefined ? (
        <p className="py-4 text-center text-sm text-muted-foreground" role="status">
          {loadingMoreLabel}
        </p>
      ) : null}
    </div>
  );
}
