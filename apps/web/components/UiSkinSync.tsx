"use client";

import { useEffect, useLayoutEffect } from "react";

// useLayoutEffect fires before the browser paints the hydrated tree; on the
// server it would warn, so fall back to useEffect there (it never runs).
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * Re-asserts the Umber skin class after hydration. The pre-paint script in
 * the root layout handles the first paint, but React 19 hydration replaces
 * <html>'s className with the rendered value, stripping classes added by
 * scripts. The dark class survives only because useTheme re-applies it from
 * its own effect — this is the equivalent half for the skin flag.
 */
export function UiSkinSync() {
  useIsomorphicLayoutEffect(() => {
    try {
      if (localStorage.getItem("ui-skin") === "umber") {
        document.documentElement.classList.add("skin-umber");
      }
    } catch {
      /* storage disabled */
    }
  }, []);
  return null;
}
