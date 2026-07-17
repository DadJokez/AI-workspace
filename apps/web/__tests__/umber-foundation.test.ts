import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "@ai-workspace/umber/components/forms/Button";
import { Orb } from "@ai-workspace/umber/components/media/Orb";

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

  // The skin blocks in globals.css mirror Umber tokens as RGB triplets. This
  // derives the expected triplets from the vendored colors.css itself, so an
  // upstream token change (re-vendored via scripts/sync-umber.sh) fails CI
  // until globals.css is re-derived — the drift the CSS comment warns about.
  it("keeps the skin remap derived from packages/umber tokens", () => {
    const tokensCss = readFileSync(
      join(__dirname, "../../../packages/umber/tokens/colors.css"),
      "utf8",
    );
    const globals = readFileSync(join(__dirname, "../app/globals.css"), "utf8");

    const declsIn = (scopePattern: RegExp): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const m of tokensCss.matchAll(
        new RegExp(`${scopePattern.source}\\s*\\{([^}]*)\\}`, "g"),
      )) {
        for (const d of (m[1] ?? "").matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
          out[d[1] as string] = (d[2] as string).trim();
        }
      }
      return out;
    };
    const light = declsIn(/:root/);
    const dark = { ...light, ...declsIn(/\[data-theme="dark"\]/) };

    const resolve = (scope: Record<string, string>, name: string): string => {
      let v = scope[name];
      for (let i = 0; v && i < 10; i++) {
        const ref = v.match(/^var\((--[\w-]+)\)$/);
        if (!ref) break;
        v = scope[ref[1] as string];
      }
      if (!v || !/^#[0-9a-f]{6}$/i.test(v)) {
        throw new Error(`cannot resolve ${name} to a hex color (got ${v})`);
      }
      return [1, 3, 5]
        .map((i) => parseInt(v.slice(i, i + 2), 16))
        .join(" ");
    };

    // slot in globals.css → Umber semantic token it mirrors
    const mapping: Record<
      string,
      { scope: Record<string, string>; slots: Record<string, string> }
    > = {
      "html.skin-umber ": {
        scope: light,
        slots: {
          canvas: "--bg",
          surface: "--surface",
          sidebar: "--surface-2",
          hairline: "--border",
          ink: "--text",
          muted: "--text-muted",
          subtle: "--surface-active",
          accent: "--action",
          pop: "--pop",
        },
      },
      "html.dark.skin-umber ": {
        scope: dark,
        slots: {
          canvas: "--bg",
          surface: "--surface",
          sidebar: "--surface-2",
          hairline: "--border",
          ink: "--text",
          muted: "--text-muted",
          subtle: "--surface-hover",
          accent: "--action",
          pop: "--pop",
        },
      },
    };

    for (const [scopeSel, { scope, slots }] of Object.entries(mapping)) {
      const start = globals.indexOf(scopeSel);
      expect(start, `${scopeSel} block missing`).toBeGreaterThan(-1);
      const block = globals.slice(start, globals.indexOf("}", start));
      for (const [slot, token] of Object.entries(slots)) {
        const triplet = block.match(
          new RegExp(`--color-${slot}:\\s*([\\d ]+);`),
        )?.[1];
        expect(
          triplet,
          `${scopeSel}--color-${slot} should mirror ${token}`,
        ).toBe(resolve(scope, token));
      }
    }
  });
});
