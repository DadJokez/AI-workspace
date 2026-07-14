import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The design system's rule is "never recreate or approximate the Orb."
// ThinkingOrb.tsx is a deliberate, exact React port of the mark (kept for its
// app-specific perf work: IntersectionObserver pausing across long threads,
// per-message static frames). Exactness is the license for its existence —
// this guard fails CI if the vendored Orb's keyframe geometry ever drifts
// from the port, at which point the port must be re-derived (or replaced
// with the vendored component).
describe("brand orb parity (ThinkingOrb ↔ packages/umber Orb)", () => {
  it("keyframe paths are identical", () => {
    const port = readFileSync(
      join(__dirname, "../components/ThinkingOrb.tsx"),
      "utf8",
    );
    const vendored = readFileSync(
      join(__dirname, "../../../packages/umber/components/media/Orb.jsx"),
      "utf8",
    );

    const paths = (src: string): string[] =>
      [...src.matchAll(/"(M100,4[02] C[^"]+Z)"/g)].map((m) => m[1] as string);

    const portPaths = paths(port);
    const vendoredPaths = paths(vendored);
    expect(portPaths, "port should define exactly two keyframe paths").toHaveLength(2);
    expect(vendoredPaths, "vendored Orb should define exactly two keyframe paths").toHaveLength(2);
    expect(portPaths).toEqual(vendoredPaths);
  });
});
