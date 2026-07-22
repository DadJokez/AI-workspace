import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "@ai-workspace/umber/components/forms/Button";
import { Orb } from "@ai-workspace/umber/components/media/Orb";

function declarations(css: string, selector: RegExp) {
  const values: Record<string, string> = {};
  for (const match of css.matchAll(
    new RegExp(`${selector.source}\\s*\\{([^}]*)\\}`, "g"),
  )) {
    for (const declaration of (match[1] ?? "").matchAll(
      /(--[\w-]+):\s*([^;]+);/g,
    )) {
      values[declaration[1] as string] = (declaration[2] as string).trim();
    }
  }
  return values;
}

function resolveHex(values: Record<string, string>, name: string) {
  let value = values[name];
  for (let depth = 0; value && depth < 12; depth += 1) {
    const reference = value.match(/^var\((--[\w-]+)\)$/);
    if (!reference) break;
    value = values[reference[1] as string];
  }
  if (!value || !/^#[\da-f]{6}$/i.test(value)) {
    throw new Error(`Could not resolve ${name} to a color (got ${value})`);
  }
  return value;
}

function contrastRatio(foreground: string, background: string) {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((index) =>
      Number.parseInt(hex.slice(index, index + 2), 16),
    );
    const linear = channels.map((channel) => {
      const value = channel / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
  };
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".tsx") ? [path] : [];
  });
}

describe("umber foundation (packages/umber)", () => {
  it("renders vendored components on the server", () => {
    const button = renderToString(
      createElement(Button, { variant: "pop" }, "New chat"),
    );
    expect(button).toContain("New chat");
    expect(button).toContain("var(--pop)");

    // The brand mark must come from the design system, never hand-rolled.
    const orb = renderToString(
      createElement(Orb, { state: "idle", label: "Comparative" }),
    );
    expect(orb).toContain("comparative-orb");
  });

  it("imports the Umber decision tokens and maps app colors by reference", () => {
    const globals = readFileSync(join(__dirname, "../app/globals.css"), "utf8");
    const tailwind = readFileSync(
      join(__dirname, "../tailwind.config.ts"),
      "utf8",
    );

    for (const file of [
      "fonts.css",
      "colors.css",
      "typography.css",
      "spacing.css",
      "effects.css",
    ]) {
      expect(globals).toContain(`@ai-workspace/umber/tokens/${file}`);
    }
    expect(globals).not.toContain("tokens/base.css");
    expect(globals).not.toContain("tokens/texture.css");

    const mapping: Record<string, string> = {
      canvas: "--bg",
      surface: "--surface",
      sidebar: "--surface-2",
      hairline: "--border",
      ink: "--text",
      muted: "--text-muted",
      subtle: "--surface-active",
      accent: "--action",
      pop: "--pop",
      "on-accent": "--action-fg",
      "on-pop": "--pop-fg",
      danger: "--danger",
      "danger-bg": "--danger-bg",
      "success-bg": "--success-bg",
      "warning-bg": "--warning-bg",
    };

    for (const [slot, token] of Object.entries(mapping)) {
      expect(globals).toContain(`--color-${slot}: var(${token});`);
    }

    expect(globals).not.toMatch(/--color-[\w-]+:\s*[\d ]+;/);
    expect(globals).toContain("--color-success: var(--forest-500);");
    expect(globals).toContain("--color-warning: var(--tan-800);");
    expect(globals).toContain("--color-info: var(--neutral-300);");
    expect(tailwind).toContain(
      "rgb(from var(--color-${name}) r g b / <alpha-value>)",
    );
  });

  it("wires Umber type, spacing, radius, shadow, and motion tokens into Tailwind", () => {
    const tailwind = readFileSync(
      join(__dirname, "../tailwind.config.ts"),
      "utf8",
    );

    for (const token of [
      "--text-2xs",
      "--text-base",
      "--text-5xl",
      "--leading-normal",
      "--fw-semibold",
      "--space-4",
      "--radius-md",
      "--shadow-focus",
      "--dur-base",
      "--ease-out",
    ]) {
      expect(tailwind).toContain(`var(${token})`);
    }
  });

  it("self-hosts the brand fonts within the app payload", () => {
    const layout = readFileSync(join(__dirname, "../app/layout.tsx"), "utf8");
    const globals = readFileSync(join(__dirname, "../app/globals.css"), "utf8");
    const fontsDirectory = join(__dirname, "../app/fonts");
    const fontFiles = [
      "Geist-Variable.woff2",
      "GeistMono-Variable.woff2",
      "Newsreader-Regular.woff2",
      "Newsreader-Italic.woff2",
    ];

    expect(layout).toContain('from "next/font/local"');
    for (const fontFile of fontFiles) {
      expect(layout).toContain(`./fonts/${fontFile}`);
      expect(statSync(join(fontsDirectory, fontFile)).size).toBeGreaterThan(0);
    }
    expect(
      fontFiles.reduce(
        (bytes, fontFile) => bytes + statSync(join(fontsDirectory, fontFile)).size,
        0,
      ),
    ).toBeLessThan(400_000);

    expect(globals).toContain("var(--font-geist-local)");
    expect(globals).toContain("var(--font-geist-mono-local)");
    expect(globals).toContain("var(--font-newsreader-local)");
    expect(layout).not.toMatch(/fonts\.(?:googleapis|gstatic)\.com/);
    expect(globals).not.toMatch(/fonts\.(?:googleapis|gstatic)\.com/);
  });

  it("keeps app typography on the shared scale", () => {
    const roots = [join(__dirname, "../app"), join(__dirname, "../components")];
    const offenders = roots.flatMap((root) =>
      sourceFiles(root).flatMap((file) => {
        const matches = readFileSync(file, "utf8").match(/text-\[\d+px\]/g);
        return matches?.map((match) => `${file}: ${match}`) ?? [];
      }),
    );

    expect(offenders).toEqual([]);
  });

  it("keeps status foregrounds AA-readable on their light and dark backgrounds", () => {
    const tokens = readFileSync(
      join(__dirname, "../../../packages/umber/tokens/colors.css"),
      "utf8",
    );
    const globals = readFileSync(join(__dirname, "../app/globals.css"), "utf8");
    const light = {
      ...declarations(tokens, /:root/),
      ...declarations(globals, /:root/),
    };
    const dark = {
      ...light,
      ...declarations(tokens, /\[data-theme="dark"\]/),
      ...declarations(globals, /\[data-theme="dark"\]/),
    };

    const measured = (values: Record<string, string>) =>
      Object.fromEntries(
        ["danger", "success", "warning", "info"].map((status) => [
          status,
          Number(
            contrastRatio(
              resolveHex(values, `--color-${status}`),
              resolveHex(values, `--color-${status}-bg`),
            ).toFixed(2),
          ),
        ]),
      );

    const ratios = { light: measured(light), dark: measured(dark) };
    expect(ratios).toEqual({
      light: { danger: 4.55, success: 8.15, warning: 7.24, info: 8.98 },
      dark: { danger: 4.95, success: 5.78, warning: 6.71, info: 6.02 },
    });
    for (const theme of [light, dark]) {
      expect(resolveHex(theme, "--color-info")).not.toBe(
        resolveHex(theme, "--color-success"),
      );
      expect(resolveHex(theme, "--color-info-bg")).not.toBe(
        resolveHex(theme, "--color-success-bg"),
      );
    }
    for (const theme of Object.values(ratios)) {
      for (const ratio of Object.values(theme)) {
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
