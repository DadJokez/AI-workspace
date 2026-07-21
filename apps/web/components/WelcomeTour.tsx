"use client";

import { TOUR_STEPS } from "@/lib/tour";
import { useCallback, useEffect, useRef, useState } from "react";

interface WelcomeTourProps {
  open: boolean;
  /** Fired when the user finishes or skips; parent persists completion. */
  onClose: () => void;
}

interface AnchorRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const SPOTLIGHT_PADDING = 6;

/**
 * First-run welcome tour (#136): a centered welcome card, then spotlight
 * steps anchored to live surfaces via `data-tour` attributes. In-house and
 * dependency-free — a fixed overlay whose "cutout" is drawn with an oversized
 * box-shadow around the anchored element. Steps with no visible anchor fall
 * back to a centered card, so the tour works on mobile where the sidebar is
 * a drawer. Esc or "Skip tour" closes; both count as completion.
 */
export function WelcomeTour({ open, onClose }: WelcomeTourProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<AnchorRect | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const step = TOUR_STEPS[stepIndex] ?? TOUR_STEPS[0]!;
  const isLast = stepIndex === TOUR_STEPS.length - 1;

  const measure = useCallback(() => {
    if (!step.anchor) {
      setRect(null);
      return;
    }
    const el = document.querySelector(`[data-tour="${step.anchor}"]`);
    if (!el) {
      setRect(null);
      return;
    }
    const box = el.getBoundingClientRect();
    const visible =
      box.width > 0 &&
      box.height > 0 &&
      box.bottom > 0 &&
      box.right > 0 &&
      box.top < window.innerHeight &&
      box.left < window.innerWidth;
    setRect(
      visible
        ? { top: box.top, left: box.left, width: box.width, height: box.height }
        : null,
    );
  }, [step.anchor]);

  useEffect(() => {
    if (!open) return;
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight" && !isLast) setStepIndex((i) => i + 1);
      if (e.key === "ArrowLeft" && stepIndex > 0) setStepIndex((i) => i - 1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, isLast, stepIndex, onClose]);

  // Reset to the first step whenever the tour is (re)opened.
  useEffect(() => {
    if (open) setStepIndex(0);
  }, [open]);

  if (!open) return null;

  const spotlight = rect
    ? {
        top: rect.top - SPOTLIGHT_PADDING,
        left: rect.left - SPOTLIGHT_PADDING,
        width: rect.width + SPOTLIGHT_PADDING * 2,
        height: rect.height + SPOTLIGHT_PADDING * 2,
      }
    : null;

  return (
    <div
      className="fixed inset-0 z-[90]"
      role="dialog"
      aria-modal="true"
      aria-label="Welcome tour"
    >
      {/* Backdrop. With a spotlight, the dark layer is the cutout's shadow. */}
      {spotlight ? (
        <div
          className="pointer-events-none fixed rounded-lg ring-2 ring-ink/30"
          style={{
            top: spotlight.top,
            left: spotlight.left,
            width: spotlight.width,
            height: spotlight.height,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
          }}
        />
      ) : (
        <div className="fixed inset-0 bg-black/55" />
      )}
      {/* Click-away on the backdrop advances rather than closes — first-run
          users dismiss accidentally otherwise. Explicit close stays in the
          card. */}
      <button
        type="button"
        aria-label={isLast ? "Finish tour" : "Next step"}
        className="fixed inset-0 cursor-default"
        onClick={() => (isLast ? onClose() : setStepIndex((i) => i + 1))}
      />

      <div
        ref={cardRef}
        className="fixed left-1/2 w-[min(92vw,420px)] -translate-x-1/2 rounded-xl border border-hairline bg-canvas p-5 text-ink shadow-2xl"
        style={cardPosition(spotlight)}
      >
        <p className="text-2xs font-medium uppercase tracking-wider text-muted">
          {stepIndex + 1} of {TOUR_STEPS.length}
        </p>
        <h2 className="mt-1.5 text-md font-semibold">{step.title}</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          {step.body}
        </p>
        <div className="mt-4 flex items-center justify-between">
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-muted hover:text-ink"
          >
            Skip tour
          </button>
          <div className="flex items-center gap-2">
            {stepIndex > 0 ? (
              <button
                type="button"
                onClick={() => setStepIndex((i) => i - 1)}
                className="rounded-md border border-hairline px-3 py-1.5 text-sm text-ink hover:bg-subtle"
              >
                Back
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => (isLast ? onClose() : setStepIndex((i) => i + 1))}
              className="rounded-md bg-ink px-3.5 py-1.5 text-sm font-medium text-canvas hover:opacity-90"
            >
              {isLast ? "Get started" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Place the card under the spotlight when there's room, above it when not,
 * and centered when there's no spotlight at all.
 */
function cardPosition(
  spotlight: { top: number; height: number } | null,
): React.CSSProperties {
  if (!spotlight) {
    return { top: "50%", transform: "translate(-50%, -50%)" };
  }
  const below = spotlight.top + spotlight.height + 14;
  if (typeof window !== "undefined" && below + 240 > window.innerHeight) {
    return { bottom: window.innerHeight - spotlight.top + 14 };
  }
  return { top: below };
}
