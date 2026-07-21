"use client";

import { useTheme } from "@/lib/theme";

export function ThemeToggle() {
  const { isDark, toggle } = useTheme();
  return (
    <button
      type="button"
      data-theme-toggle
      onClick={toggle}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-subtle hover:text-ink"
    >
      {isDark ? (
        <svg
          viewBox="0 0 20 20"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="10" cy="10" r="3.25" />
          <path d="M10 2.5v1.5M10 16v1.5M2.5 10H4M16 10h1.5M4.4 4.4l1.05 1.05M14.55 14.55L15.6 15.6M4.4 15.6l1.05-1.05M14.55 5.45L15.6 4.4" />
        </svg>
      ) : (
        <svg
          viewBox="0 0 20 20"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M16.5 12.5A6.5 6.5 0 1 1 7.5 3.5a5.5 5.5 0 0 0 9 9z" />
        </svg>
      )}
    </button>
  );
}
