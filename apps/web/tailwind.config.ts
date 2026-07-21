import type { Config } from "tailwindcss";

const semanticColor = (name: string) =>
  `rgb(from var(--color-${name}) r g b / <alpha-value>)`;

const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: semanticColor("canvas"),
        surface: semanticColor("surface"),
        sidebar: semanticColor("sidebar"),
        hairline: semanticColor("hairline"),
        ink: semanticColor("ink"),
        muted: semanticColor("muted"),
        subtle: semanticColor("subtle"),
        accent: semanticColor("accent"),
        pop: semanticColor("pop"),
        "on-accent": semanticColor("on-accent"),
        "on-pop": semanticColor("on-pop"),
        danger: semanticColor("danger"),
        "danger-bg": semanticColor("danger-bg"),
        success: semanticColor("success"),
        "success-bg": semanticColor("success-bg"),
        warning: semanticColor("warning"),
        "warning-bg": semanticColor("warning-bg"),
        info: semanticColor("info"),
        "info-bg": semanticColor("info-bg"),
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
        serif: ["var(--font-serif)"],
        mono: ["var(--font-mono)"],
        system: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "'Segoe UI'",
          "Inter",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
};

export default config;
