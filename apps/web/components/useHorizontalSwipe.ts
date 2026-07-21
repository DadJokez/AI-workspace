"use client";

import {
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";

interface Options {
  direction: "left" | "right";
  onSwipe: () => void;
  disabled?: boolean;
  edge?: "left";
}

interface ActiveGesture {
  pointerId: number;
  startX: number;
  startY: number;
}

const EDGE_WIDTH = 24;
const MIN_DISTANCE = 72;
const DIRECTION_RATIO = 1.2;

/**
 * Recognizes deliberate touch swipes without taking scroll ownership. A
 * gesture that starts in horizontally scrollable content remains entirely
 * native, which keeps tables and code blocks usable inside full-screen panes.
 */
export function useHorizontalSwipe({
  direction,
  onSwipe,
  disabled = false,
  edge,
}: Options) {
  const callbackRef = useRef(onSwipe);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    callbackRef.current = onSwipe;
  }, [onSwipe]);

  useEffect(() => () => cleanupRef.current?.(), []);

  return useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (
        disabled ||
        event.pointerType !== "touch" ||
        !event.isPrimary ||
        window.matchMedia("(min-width: 768px)").matches ||
        (edge === "left" && event.clientX > EDGE_WIDTH) ||
        startsInHorizontalScroller(event.target, event.currentTarget)
      ) {
        return;
      }

      cleanupRef.current?.();
      const active: ActiveGesture = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
      };

      const cleanup = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", cleanup);
        window.removeEventListener("pointercancel", cleanup);
        if (cleanupRef.current === cleanup) cleanupRef.current = null;
      };

      const handleMove = (move: PointerEvent) => {
        if (move.pointerId !== active.pointerId) return;
        const deltaX = move.clientX - active.startX;
        const deltaY = move.clientY - active.startY;
        const horizontal = Math.abs(deltaX);
        const vertical = Math.abs(deltaY);

        if (vertical >= MIN_DISTANCE && vertical > horizontal) {
          cleanup();
          return;
        }
        if (
          horizontal < MIN_DISTANCE ||
          horizontal < vertical * DIRECTION_RATIO
        ) {
          return;
        }

        const matches = direction === "right" ? deltaX > 0 : deltaX < 0;
        cleanup();
        if (matches) callbackRef.current();
      };

      cleanupRef.current = cleanup;
      window.addEventListener("pointermove", handleMove, { passive: true });
      window.addEventListener("pointerup", cleanup, { passive: true });
      window.addEventListener("pointercancel", cleanup, { passive: true });
    },
    [direction, disabled, edge],
  );
}

function startsInHorizontalScroller(
  target: EventTarget,
  boundary: HTMLElement,
): boolean {
  let element = target instanceof Element ? target : null;
  while (element) {
    const style = window.getComputedStyle(element);
    if (
      (style.overflowX === "auto" || style.overflowX === "scroll") &&
      element.scrollWidth > element.clientWidth + 1
    ) {
      return true;
    }
    if (element === boundary) return false;
    element = element.parentElement;
  }
  return false;
}
