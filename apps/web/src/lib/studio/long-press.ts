'use client';

import { type PointerEvent, type SyntheticEvent, useEffect, useRef } from 'react';

/** How long a finger rests on an item before its menu opens. */
export const LONG_PRESS_MS = 500;
/** Moving further than this (px) is a scroll, not a press. */
const MOVE_TOLERANCE_PX = 10;

/**
 * Long-press on touch (and pen): after LONG_PRESS_MS without moving, `onLongPress` gets the press
 * point. The click that follows lifting the finger is swallowed, so a long-press never also
 * opens or selects the item. Mouse input is ignored (it has right-click).
 */
export function useLongPress(onLongPress: (point: { x: number; y: number }) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const callback = useRef(onLongPress);
  useEffect(() => {
    callback.current = onLongPress;
  });
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  function cancel() {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  }

  return {
    onPointerDown(event: PointerEvent) {
      if (event.pointerType === 'mouse') return;
      cancel();
      fired.current = false;
      const point = { x: event.clientX, y: event.clientY };
      start.current = point;
      timer.current = setTimeout(() => {
        timer.current = null;
        fired.current = true;
        callback.current(point);
      }, LONG_PRESS_MS);
    },
    onPointerMove(event: PointerEvent) {
      const origin = start.current;
      if (origin === null) return;
      if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > MOVE_TOLERANCE_PX) {
        cancel();
      }
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onClickCapture(event: SyntheticEvent) {
      if (!fired.current) return;
      fired.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
