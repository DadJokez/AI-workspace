import type { Metadata, Viewport } from "next";
import { AlphaBadge } from "@/components/AlphaBadge";
import { CommandPaletteProvider } from "@/components/CommandPalette";
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
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.setAttribute('data-theme', theme);
    // Umber is the default; an explicit Classic preference is the temporary
    // escape hatch. This covers the FIRST paint only: React 19 hydration then
    // replaces <html>'s className,
    // stripping script-added classes — the dark class above survives only
    // because useTheme re-applies it in an effect, and UiSkinSync (mounted in
    // the body below) is the equivalent required re-assert for this class.
    if (localStorage.getItem('ui-skin') !== 'classic') {
      document.documentElement.classList.add('skin-umber');
    }
    if (localStorage.getItem('ai-workspace-density') === 'compact') {
      document.documentElement.classList.add('density-compact');
    }
  } catch (e) {}
})();
`;

function BuiltByMark() {
  // Rob & Robot lockup (assets from DadJokez/rob-and-robot): ink on light
  // themes, tan on dark — the brand palette matches both skins. Fixed
  // bottom-right, under the safe-area inset, below modal layers.
  const shared =
    "h-5 w-auto opacity-50 transition-opacity duration-base group-hover:opacity-90";
  return (
    <div
      title="Built by Rob and Robot"
      aria-label="Built by Rob and Robot"
      className="group fixed bottom-[max(env(safe-area-inset-bottom),0.375rem)] right-2 z-40 select-none"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- 4KB static badge; the image optimizer would cost more than it saves. */}
      <img
        src="/brand/rob-and-robot-ink.png"
        alt="Rob and Robot"
        className={`${shared} dark:hidden`}
      />
      {/* eslint-disable-next-line @next/next/no-img-element -- see above. */}
      <img
        src="/brand/rob-and-robot-tan.png"
        alt=""
        aria-hidden="true"
        className={`${shared} hidden dark:block`}
      />
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
        <CommandPaletteProvider>{children}</CommandPaletteProvider>
        <BuiltByMark />
      </body>
    </html>
  );
}
