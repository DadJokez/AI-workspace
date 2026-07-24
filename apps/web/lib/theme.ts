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
  // Keep the server render and the browser's first render identical. The
  // inline script in app/layout.tsx applies the saved theme before paint; this
  // hook adopts that preference after hydration. Reading localStorage or
  // matchMedia in the state initializer makes dark-mode clients render
  // different SVG/attributes than the server and triggers a React hydration
  // recovery.
  const [theme, setThemeState] = useState<Theme>("system");
  const [isDark, setIsDark] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const storedTheme = readStoredTheme();
    const dark = effectivelyDark(storedTheme);
    setThemeState(storedTheme);
    setIsDark(dark);
    applyClass(dark);
    setHydrated(true);
  }, []);

  // Apply theme + persist whenever it changes.
  useEffect(() => {
    if (!hydrated) return;
    const dark = effectivelyDark(theme);
    setIsDark(dark);
    applyClass(dark);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* quota / disabled */
    }
  }, [hydrated, theme]);

  // While in "system" mode, react to OS-level theme changes.
  useEffect(() => {
    if (!hydrated) return;
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
  }, [hydrated, theme]);

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
