import type { Metadata, Viewport } from "next";
import { UiSkinSync } from "@/components/UiSkinSync";
import "./globals.css";

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
    if (theme === 'dark') document.documentElement.classList.add('dark');
    // Umber reskin opt-in (globals.css html.skin-umber). This covers the
    // FIRST paint only: React 19 hydration then replaces <html>'s className,
    // stripping script-added classes — the dark class above survives only
    // because useTheme re-applies it in an effect, and UiSkinSync (mounted in
    // the body below) is the equivalent required re-assert for this class.
    if (localStorage.getItem('ui-skin') === 'umber') {
      document.documentElement.classList.add('skin-umber');
    }
  } catch (e) {}
})();
`;

function AlphaBadge() {
  return (
    <div
      aria-label="Alpha version"
      className="pointer-events-none fixed left-1/2 top-[max(env(safe-area-inset-top),0.5rem)] z-[90] -translate-x-1/2 rounded-full border border-[#87b5ff]/70 bg-[#0047ff] px-2.5 py-1 text-[10px] font-semibold uppercase leading-none tracking-[0.18em] text-white shadow-[0_0_24px_rgba(0,71,255,0.55)] ring-1 ring-white/20"
    >
      Alpha
    </div>
  );
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Comparative ships a real native dark mode (and the Umber skin).
            Dark Reader's forced repaint sits on top of the app's theme
            classes, so the sun/moon toggle and Light/Dark/System controls
            appear dead while working correctly underneath (live tester
            confusion, 2026-07-17). This lock tag tells Dark Reader to leave
            the site alone. */}
        <meta name="darkreader-lock" />
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="bg-canvas text-ink antialiased">
        <UiSkinSync />
        <AlphaBadge />
        {children}
      </body>
    </html>
  );
}
