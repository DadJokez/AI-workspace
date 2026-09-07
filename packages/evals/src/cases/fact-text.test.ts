import { describe, expect, it } from "vitest";
import { normalizeFactText } from "./fact-text";

describe("fact typography", () => {
  it("normalizes non-breaking typography and one transport newline", () => {
    expect(normalizeFactText("Priya\u202fShah 2026\u201109\u201117\r\n")).toBe("Priya Shah 2026-09-17");
    expect(normalizeFactText("Alder &\u00a0Finch")).toBe("Alder & Finch");
  });
  it("does not rewrite facts or other punctuation, casing, or whitespace", () => {
    expect(normalizeFactText("2026-09-18")).not.toBe("2026-09-17");
    expect(normalizeFactText("  3\u22124\tPM\n\n")).toBe("  3\u22124\tPM\n");
    expect(normalizeFactText("Priya SHAH")).not.toBe("Priya Shah");
  });
});
