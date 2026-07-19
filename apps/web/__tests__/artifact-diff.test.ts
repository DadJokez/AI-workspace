import { describe, expect, it } from "vitest";
import { computeLineDelta } from "@/lib/artifact-diff";

describe("computeLineDelta", () => {
  it("counts a single-region edit exactly", () => {
    const prev = "a\nb\nc\nd";
    const next = "a\nX\nY\nc\nd";
    expect(computeLineDelta(prev, next)).toEqual({
      added: 2,
      removed: 1,
      approximate: false,
    });
  });

  it("counts scattered edits exactly via Myers", () => {
    const prev = "one\ntwo\nthree\nfour\nfive";
    const next = "one\nTWO\nthree\nfour\nFIVE\nsix";
    expect(computeLineDelta(prev, next)).toEqual({
      added: 3,
      removed: 2,
      approximate: false,
    });
  });

  it("returns zeros for identical content and pure append/delete", () => {
    expect(computeLineDelta("a\nb", "a\nb")).toEqual({
      added: 0,
      removed: 0,
      approximate: false,
    });
    expect(computeLineDelta("a\nb", "a\nb\nc\nd")).toEqual({
      added: 2,
      removed: 0,
      approximate: false,
    });
    expect(computeLineDelta("a\nb\nc", "a")).toEqual({
      added: 0,
      removed: 2,
      approximate: false,
    });
  });

  it("marks the fallback approximate when the edit-distance bound trips", () => {
    const prev = Array.from({ length: 2000 }, (_, n) => `p${n}`).join("\n");
    const next = Array.from({ length: 2000 }, (_, n) => `q${n}`).join("\n");
    const delta = computeLineDelta(prev, next);
    expect(delta).toMatchObject({ approximate: true });
    expect(delta!.added).toBe(2000);
    expect(delta!.removed).toBe(2000);
  });

  it("bails to null on oversized content", () => {
    expect(computeLineDelta("x".repeat(400_001), "y")).toBeNull();
  });
});
