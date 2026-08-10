"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useHorizontalSwipe } from "@/components/useHorizontalSwipe";

interface Props {
  ariaLabel: string;
  children: ReactNode;
  defaultWidth: number;
  maxWidth: number;
  minWidth: number;
  onClose: () => void;
  resizerLabel: string;
  storageKey: string;
  paneTestId?: string;
  resizerTestId?: string;
  minMainWidth?: number;
  maximized?: boolean;
  onMaximizedChange?: (maximized: boolean) => void;
}

const DEFAULT_MIN_MAIN_WIDTH = 420;

export function SlideOverPane({
  ariaLabel,
  children,
  defaultWidth,
  maxWidth,
  minWidth,
  onClose,
  resizerLabel,
  storageKey,
  paneTestId,
  resizerTestId,
  minMainWidth = DEFAULT_MIN_MAIN_WIDTH,
  maximized = false,
  onMaximizedChange,
}: Props) {
  const [width, setWidth] = useState(defaultWidth);
  const paneRef = useRef<HTMLElement>(null);
  const dismissSwipe = useHorizontalSwipe({
    direction: "left",
    onSwipe: onClose,
  });

  const clampWidth = useCallback(
    (next: number) => {
      if (typeof window === "undefined") {
        return Math.min(maxWidth, Math.max(minWidth, next));
      }
      const containerWidth =
        paneRef.current?.parentElement?.getBoundingClientRect().width ??
        window.innerWidth;
      const maxByViewport = Math.max(
        minWidth,
        containerWidth - minMainWidth,
      );
      return Math.min(
        Math.min(maxWidth, maxByViewport),
        Math.max(minWidth, next),
      );
    },
    [maxWidth, minMainWidth, minWidth],
  );

  useEffect(() => {
    const storedWidth = Number.parseInt(
      window.localStorage.getItem(storageKey) ?? "",
      10,
    );
    if (Number.isFinite(storedWidth)) {
      setWidth(clampWidth(storedWidth));
    }

    const handleViewportResize = () => {
      setWidth((current) => clampWidth(current));
    };
    window.addEventListener("resize", handleViewportResize);
    return () => window.removeEventListener("resize", handleViewportResize);
  }, [clampWidth, storageKey]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [onClose]);

  function updateAndPersistWidth(next: number) {
    onMaximizedChange?.(false);
    const clamped = clampWidth(next);
    setWidth(clamped);
    window.localStorage.setItem(storageKey, String(Math.round(clamped)));
  }

  function startResize(event: ReactPointerEvent<HTMLElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = maximized ? clampWidth(maxWidth) : width;
    let latestWidth = startWidth;
    onMaximizedChange?.(false);

    const handleMove = (move: PointerEvent) => {
      latestWidth = clampWidth(startWidth + startX - move.clientX);
      setWidth(latestWidth);
    };
    const stop = () => {
      window.localStorage.setItem(storageKey, String(Math.round(latestWidth)));
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }

  function handleResizeKey(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.shiftKey ? 80 : 24;
    const currentWidth = maximized ? clampWidth(maxWidth) : width;
    updateAndPersistWidth(
      currentWidth + (event.key === "ArrowLeft" ? step : -step),
    );
  }

  const renderedWidth = maximized ? clampWidth(maxWidth) : width;
  const style = {
    "--slide-over-width": `${renderedWidth}px`,
  } as CSSProperties;

  return (
    <>
      <div
        aria-hidden="true"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/30 md:hidden"
      />
      <aside
        ref={paneRef}
        aria-label={ariaLabel}
        data-testid={paneTestId}
        onPointerDown={dismissSwipe}
        style={style}
        className="fixed inset-y-0 right-0 z-50 flex w-full touch-pan-y flex-col border-l border-hairline bg-canvas text-ink shadow-2xl md:static md:z-auto md:h-full md:w-[var(--slide-over-width)] md:max-w-none md:shrink-0 md:shadow-none"
      >
        <div
          role="separator"
          aria-label={resizerLabel}
          aria-orientation="vertical"
          aria-valuemin={minWidth}
          aria-valuemax={maxWidth}
          aria-valuenow={Math.round(renderedWidth)}
          data-testid={resizerTestId}
          tabIndex={0}
          onPointerDown={startResize}
          onKeyDown={handleResizeKey}
          className="absolute left-0 top-0 hidden h-full w-2 -translate-x-1 cursor-col-resize touch-none border-0 bg-transparent p-0 md:block"
        >
          <span className="mx-auto block h-full w-px bg-hairline transition-colors hover:bg-ink/40" />
        </div>
        {children}
      </aside>
    </>
  );
}
