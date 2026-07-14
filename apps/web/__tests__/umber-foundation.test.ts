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

  it("keeps the skin remap aligned with the app's semantic color slots", () => {
    const css = readFileSync(join(__dirname, "../app/globals.css"), "utf8");
    const slots = [
      "canvas",
      "surface",
      "sidebar",
      "hairline",
      "ink",
      "muted",
      "subtle",
      "accent",
    ];
    for (const scope of [
      'html[data-skin="umber"]',
      'html.dark[data-skin="umber"]',
    ]) {
      const start = css.indexOf(scope);
      expect(start, `${scope} block missing`).toBeGreaterThan(-1);
      const block = css.slice(start, css.indexOf("}", start));
      for (const slot of slots) {
        expect(block, `${scope} missing --color-${slot}`).toContain(
          `--color-${slot}:`,
        );
      }
    }
  });
});
