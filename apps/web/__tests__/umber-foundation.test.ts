import { readFileSync } from "node:fs";
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
    expect(globals).toContain("--color-info: var(--forest-200);");
    expect(tailwind).toContain(
      "rgb(from var(--color-${name}) r g b / <alpha-value>)",
    );
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
      light: { danger: 4.55, success: 8.15, warning: 7.24, info: 8.14 },
      dark: { danger: 4.95, success: 5.78, warning: 6.71, info: 7.28 },
    });
    for (const theme of Object.values(ratios)) {
      for (const ratio of Object.values(theme)) {
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
