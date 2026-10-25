'use client';

import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * A virtualized grid of drive items (TanStack Virtual, window scrolling) with infinite scroll:
 * only the visible rows are in the DOM, and the next cursor page loads as the user nears the end.
 * Columns follow the container width (two on phones).
 */

const MIN_CELL_PX = 160;
const GAP_PX = 12;
/** Room under each square thumbnail for the name and status line. */
const CAPTION_PX = 52;

export function columnsFor(width: number): number {
  return Math.max(2, Math.floor((width + GAP_PX) / (MIN_CELL_PX + GAP_PX)));
}

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Width of the element and its offset from the top of the page (the virtualizer's scrollMargin). */
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

export interface DriveGridProps<T extends { id: string }> {
  items: readonly T[];
  renderItem: (item: T) => ReactNode;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => unknown;
  /** Accessible name of the grid. */
  label: string;
  loadingMoreLabel: string;
}

export function DriveGrid<T extends { id: string }>({
  items,
  renderItem,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  label,
  loadingMoreLabel,
}: DriveGridProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { width, top } = useBox(containerRef);
  const columns = columnsFor(width || 360);
  const cellWidth = ((width || 360) - GAP_PX * (columns - 1)) / columns;
  const rowHeight = Math.round(cellWidth + CAPTION_PX + GAP_PX);
  const rowCount = Math.ceil(items.length / columns);

  const virtualizer = useWindowVirtualizer({
    count: rowCount,
    estimateSize: () => rowHeight,
    overscan: 4,
    scrollMargin: top,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight, virtualizer]);

  const virtualRows = virtualizer.getVirtualItems();
  const lastRow = virtualRows.at(-1)?.index ?? -1;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && lastRow >= rowCount - 3) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, lastRow, rowCount, fetchNextPage]);

  return (
    <div ref={containerRef}>
      <div
        role="list"
        aria-label={label}
        aria-busy={isFetchingNextPage}
        style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}
      >
        {virtualRows.map((row) => {
          const rowItems = items.slice(row.index * columns, row.index * columns + columns);
          return (
            <div
              key={row.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: rowHeight - GAP_PX,
                transform: `translateY(${row.start - virtualizer.options.scrollMargin}px)`,
                display: 'grid',
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                gap: GAP_PX,
              }}
            >
              {rowItems.map((item) => (
                <div role="listitem" key={item.id} className="min-w-0">
                  {renderItem(item)}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {isFetchingNextPage ? (
        <p className="py-4 text-center text-sm text-muted-foreground" role="status">
          {loadingMoreLabel}
        </p>
      ) : null}
    </div>
  );
}
