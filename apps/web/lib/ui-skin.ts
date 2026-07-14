"use client";

import { useCallback, useEffect, useState } from "react";

export type UiSkin = "classic" | "umber";

// Shared with the pre-paint script in app/layout.tsx and UiSkinSync — the
// three must agree on key, value, and class name.
const STORAGE_KEY = "ui-skin";
const UMBER_CLASS = "skin-umber";

export function readStoredSkin(): UiSkin {
  if (typeof localStorage === "undefined") return "classic";
  return localStorage.getItem(STORAGE_KEY) === "umber" ? "umber" : "classic";
}

export function applySkinClass(skin: UiSkin) {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle(UMBER_CLASS, skin === "umber");
}

export function useUiSkin() {
  const [skin, setSkinState] = useState<UiSkin>(readStoredSkin);

  useEffect(() => {
    applySkinClass(skin);
    try {
      localStorage.setItem(STORAGE_KEY, skin);
    } catch {
      /* quota / disabled */
    }
  }, [skin]);

  const setSkin = useCallback((s: UiSkin) => {
    setSkinState(s);
  }, []);

  return { skin, setSkin };
}
