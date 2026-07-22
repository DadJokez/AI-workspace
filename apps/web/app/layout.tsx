import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { AlphaBadge } from "@/components/AlphaBadge";
import { CommandPaletteProvider } from "@/components/CommandPalette";
import { UiPreferencesSync } from "@/components/UiPreferencesSync";
import "./globals.css";

const geist = localFont({
  src: "./fonts/Geist-Variable.woff2",
  display: "swap",
  style: "normal",
  weight: "100 900",
  variable: "--font-geist-local",
});

const geistMono = localFont({
  src: "./fonts/GeistMono-Variable.woff2",
  display: "swap",
  style: "normal",
  weight: "100 900",
  variable: "--font-geist-mono-local",
});

const newsreader = localFont({
  src: [
    {
      path: "./fonts/Newsreader-Regular.woff2",
      style: "normal",
      weight: "400",
    },
    {
      path: "./fonts/Newsreader-Italic.woff2",
      style: "italic",
      weight: "400",
    },
  ],
  display: "swap",
  variable: "--font-newsreader-local",
});

const localFontVariables = `${geist.variable} ${geistMono.variable} ${newsreader.variable}`;

export const metadata: Metadata = {
  title: "Comparative",
  description: "Internal AI front door",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // viewport-fit=cover lets the page extend under the iPhone home indicator /
  // notch and exposes env(safe-area-inset-*) so the chat input rail can pad
  // itself off the home indicator. interactive-widget=resizes-content was
  // tried earlier but isn't supported in iOS Safari and was suspected of
  // contributing to horizontal-overflow issues, so it's been removed.
  viewportFit: "cover",
};

const themeInitScript = `
(function () {
  try {
    var stored = localStorage.getItem('theme');
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var theme = stored === 'dark' || stored === 'light'
      ? stored
      : (prefersDark ? 'dark' : 'light');
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.setAttribute('data-theme', theme);
    if (localStorage.getItem('ai-workspace-density') === 'compact') {
      document.documentElement.classList.add('density-compact');
    }
  } catch (e) {}
})();
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={localFontVariables}
      suppressHydrationWarning
    >
      <head>
        {/* Comparative ships a real native dark mode with the Umber identity.
            Dark Reader's forced repaint sits on top of the app's theme
            classes, so the sun/moon toggle and Light/Dark/System controls
            appear dead while working correctly underneath (live tester
            confusion, 2026-07-17). This lock tag tells Dark Reader to leave
            the site alone. */}
        <meta name="darkreader-lock" />
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="bg-canvas text-ink antialiased">
        <UiPreferencesSync />
        <AlphaBadge />
        <CommandPaletteProvider>{children}</CommandPaletteProvider>
      </body>
    </html>
  );
}
