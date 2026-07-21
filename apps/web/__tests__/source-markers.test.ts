import { describe, expect, it } from "vitest";
import { remarkSourceMarkers, sourceMarkerNodes } from "@/lib/source-markers";

describe("sourceMarkerNodes", () => {
  it("links only markers backed by real sources", () => {
    expect(
      sourceMarkerNodes("Use [1], not [2].", new Set([1]), "answer-a"),
    ).toEqual([
      { type: "text", value: "Use " },
      {
        type: "link",
        url: "#answer-a-1",
        children: [{ type: "text", value: "[1]" }],
      },
      { type: "text", value: ", not [2]." },
    ]);
  });

  it("leaves text untouched when no marker matches", () => {
    expect(sourceMarkerNodes("Unknown [7]", new Set([1]), "answer-a")).toEqual([
      { type: "text", value: "Unknown [7]" },
    ]);
  });
});

describe("remarkSourceMarkers", () => {
  it("does not rewrite markers already inside links", () => {
    const tree = {
      type: "root",
      children: [
        { type: "text", value: "Source [1]" },
        {
          type: "link",
          url: "https://example.com",
          children: [{ type: "text", value: "Existing [1]" }],
        },
      ],
    };

    const transform = remarkSourceMarkers([1], "answer-b")();
    transform(tree);

    expect(tree.children[0]).toEqual({
      type: "text",
      value: "Source ",
    });
    expect(tree.children[1]).toMatchObject({
      type: "link",
      url: "#answer-b-1",
    });
    expect(tree.children[2]).toEqual({
      type: "link",
      url: "https://example.com",
      children: [{ type: "text", value: "Existing [1]" }],
    });
  });
});
