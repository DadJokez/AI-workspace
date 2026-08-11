import { describe, expect, it } from "vitest";
import {
  computeArtifactLineDiff,
  computeLineDelta,
  createTextReviewAnchor,
  resolveTextReviewAnchor,
} from "@/lib/artifact-diff";

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

describe("computeArtifactLineDiff", () => {
  it("returns ordered lines with stable old and new line numbers", () => {
    const diff = computeArtifactLineDiff(
      "Heading\nOld line\nShared line",
      "Heading\nNew line\nShared line\nAdded line",
      { contextLines: 2 },
    );

    expect(diff).toMatchObject({
      added: 2,
      removed: 1,
      approximate: false,
      truncated: false,
    });
    expect(diff.entries).toEqual([
      {
        kind: "context",
        text: "Heading",
        previousLine: 1,
        nextLine: 1,
      },
      {
        kind: "removed",
        text: "Old line",
        previousLine: 2,
        nextLine: null,
      },
      {
        kind: "added",
        text: "New line",
        previousLine: null,
        nextLine: 2,
      },
      {
        kind: "context",
        text: "Shared line",
        previousLine: 3,
        nextLine: 3,
      },
      {
        kind: "added",
        text: "Added line",
        previousLine: null,
        nextLine: 4,
      },
    ]);
  });

  it("collapses unchanged regions and bounds very long rendered diffs", () => {
    const previous = Array.from({ length: 40 }, (_, index) => `line ${index}`);
    const next = [...previous];
    next[20] = "changed";
    const diff = computeArtifactLineDiff(previous.join("\n"), next.join("\n"), {
      contextLines: 2,
      maxEntries: 5,
    });

    expect(diff.truncated).toBe(true);
    expect(diff.entries).toHaveLength(5);
    expect(diff.entries.at(-1)).toMatchObject({
      kind: "omitted",
      omissionReason: "truncated",
    });
  });

  it("labels the bounded fallback as approximate", () => {
    const previous = Array.from({ length: 1_300 }, (_, index) => `old ${index}`);
    const next = Array.from({ length: 1_300 }, (_, index) => `new ${index}`);
    const diff = computeArtifactLineDiff(previous.join("\n"), next.join("\n"));

    expect(diff).toMatchObject({
      approximate: true,
      added: 1_300,
      removed: 1_300,
    });
  });
});

describe("text review anchors", () => {
  it("reopens an exact immutable-version anchor", () => {
    const content = "Alpha paragraph. Review this sentence. Omega paragraph.";
    const start = content.indexOf("Review");
    const anchor = createTextReviewAnchor(
      content,
      start,
      start + "Review this sentence.".length,
    );

    expect(resolveTextReviewAnchor(content, anchor)).toEqual({
      startOffset: start,
      endOffset: start + "Review this sentence.".length,
      resolution: "exact",
    });
  });

  it("remaps after an earlier insertion when quote context stays stable", () => {
    const original = "Alpha paragraph. Review this sentence. Omega paragraph.";
    const start = original.indexOf("Review");
    const anchor = createTextReviewAnchor(
      original,
      start,
      start + "Review this sentence.".length,
    );
    const revised = `New preface. ${original}`;

    expect(resolveTextReviewAnchor(revised, anchor)).toEqual({
      startOffset: start + "New preface. ".length,
      endOffset:
        start + "New preface. ".length + "Review this sentence.".length,
      resolution: "remapped",
    });
  });

  it("fails closed when a repeated quote cannot be disambiguated", () => {
    const original = "A repeated Z";
    const anchor = createTextReviewAnchor(original, 2, 10);
    const ambiguous = "prefix A repeated Z middle A repeated Z";

    expect(resolveTextReviewAnchor(ambiguous, anchor)).toBeNull();
  });

  it("rejects empty selections", () => {
    expect(() => createTextReviewAnchor("hello", 2, 2)).toThrow(
      "select at least one character",
    );
  });
});
