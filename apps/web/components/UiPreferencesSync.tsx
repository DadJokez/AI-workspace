"use client";

import { useEffect, useLayoutEffect } from "react";
import { applyDensityClass, readStoredDensity } from "@/lib/density";
import { migrateLegacyLocalStorage } from "@/lib/local-storage-migrations";

const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

export function UiPreferencesSync() {
  useIsomorphicLayoutEffect(() => {
    try {
      migrateLegacyLocalStorage(window.localStorage);
      applyDensityClass(readStoredDensity());
    } catch {
      /* storage disabled */
    }
  }, []);
  return null;
}
