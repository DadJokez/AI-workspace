"use client";

import { useCallback, useEffect, useState } from "react";

export type Density = "comfortable" | "compact";

const STORAGE_KEY = "ai-workspace-density";

function readStored(): Density {
  if (typeof localStorage === "undefined") return "comfortable";
  const v = localStorage.getItem(STORAGE_KEY);
  return v === "compact" ? "compact" : "comfortable";
}

function applyClass(density: Density) {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle(
    "density-compact",
    density === "compact",
  );
}

export function useDensity() {
  const [density, setDensityState] = useState<Density>(readStored);

  useEffect(() => {
    applyClass(density);
    try {
      localStorage.setItem(STORAGE_KEY, density);
    } catch {
      /* quota / disabled */
    }
  }, [density]);

  const setDensity = useCallback((d: Density) => {
    setDensityState(d);
  }, []);

  return { density, setDensity };
}
