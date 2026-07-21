"use client";

import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "theme";

function readStoredTheme(): Theme {
  if (typeof localStorage === "undefined") return "system";
  const v = localStorage.getItem(STORAGE_KEY);
  if (v === "light" || v === "dark" || v === "system") return v;
  return "system";
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function effectivelyDark(theme: Theme): boolean {
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return systemPrefersDark();
}

function applyClass(dark: boolean) {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);
  const [isDark, setIsDark] = useState<boolean>(() =>
    effectivelyDark(readStoredTheme()),
  );

  // Apply theme + persist whenever it changes.
  useEffect(() => {
    const dark = effectivelyDark(theme);
    setIsDark(dark);
    applyClass(dark);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* quota / disabled */
    }
  }, [theme]);

  // While in "system" mode, react to OS-level theme changes.
  useEffect(() => {
    if (theme !== "system") return;
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      const dark = mq.matches;
      setIsDark(dark);
      applyClass(dark);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
  }, []);

  // Quick top-bar toggle: dark <-> light. From "system", picks the opposite of
  // the currently effective state so the user gets immediate visible feedback.
  const toggle = useCallback(() => {
    setThemeState((current) => {
      const dark = effectivelyDark(current);
      return dark ? "light" : "dark";
    });
  }, []);

  return { theme, setTheme, toggle, isDark };
}
