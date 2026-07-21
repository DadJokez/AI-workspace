"use client";

import { useCallback, useEffect, useState } from "react";

export type Density = "comfortable" | "compact";

export const DENSITY_STORAGE_KEY = "ai-workspace-density";

export function readStoredDensity(): Density {
  if (typeof localStorage === "undefined") return "comfortable";
  const v = localStorage.getItem(DENSITY_STORAGE_KEY);
  return v === "compact" ? "compact" : "comfortable";
}

export function applyDensityClass(density: Density) {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle(
    "density-compact",
    density === "compact",
  );
}

export function useDensity() {
  const [density, setDensityState] = useState<Density>(readStoredDensity);

  useEffect(() => {
    applyDensityClass(density);
    try {
      localStorage.setItem(DENSITY_STORAGE_KEY, density);
    } catch {
      /* quota / disabled */
    }
  }, [density]);

  const setDensity = useCallback((d: Density) => {
    setDensityState(d);
  }, []);

  return { density, setDensity };
}
