import { describe, expect, it } from "vitest";
import {
  parseActivation,
  providerOfToolName,
  resolveMountedToolNames,
  serializeActivation,
} from "./tool-bundles";

describe("providerOfToolName", () => {
  it("extracts the provider prefix from MCP-style names", () => {
    expect(providerOfToolName("github__list_pull_requests")).toBe("github");
    expect(providerOfToolName("web__fetch_url")).toBe("web");
    expect(providerOfToolName("a__b__c")).toBe("a");
  });

  it("returns null for first-party names without the provider shape", () => {
    expect(providerOfToolName("calculator")).toBeNull();
    expect(providerOfToolName("__leading")).toBeNull();
    expect(providerOfToolName("")).toBeNull();
  });
});

describe("resolveMountedToolNames", () => {
  const all = [
    "calculator",
    "web__search",
    "github__list_prs",
    "github__create_issue",
    "notion__search",
  ];
  const dynamic = new Set([
    "github__list_prs",
    "github__create_issue",
    "notion__search",
  ]);

  it("always mounts static tools and gates dynamic ones by activation", () => {
    expect(resolveMountedToolNames(all, dynamic, new Set(["github"]))).toEqual([
      "calculator",
      "web__search",
      "github__list_prs",
      "github__create_issue",
    ]);
  });

  it("mounts only static tools when nothing is activated", () => {
    expect(resolveMountedToolNames(all, dynamic, new Set())).toEqual([
      "calculator",
      "web__search",
    ]);
  });

  it("is the identity (order included) under full activation", () => {
    expect(
      resolveMountedToolNames(all, dynamic, new Set(["github", "notion"])),
    ).toEqual(all);
  });

  it("is deterministic — same inputs, same bytes", () => {
    const a = resolveMountedToolNames(all, dynamic, new Set(["notion"]));
    const b = resolveMountedToolNames(all, dynamic, new Set(["notion"]));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never mounts a dynamic tool without a provider prefix", () => {
    expect(
      resolveMountedToolNames(
        ["oddball"],
        new Set(["oddball"]),
        new Set(["oddball"]),
      ),
    ).toEqual([]);
  });
});

describe("activation serialization", () => {
  it("dedupes, sorts, and round-trips", () => {
    const serialized = serializeActivation(["notion", "github", "notion"]);
    expect(serialized).toBe("github,notion");
    expect(parseActivation(serialized)).toEqual(["github", "notion"]);
  });

  it("treats null, undefined, and empty as no activation", () => {
    expect(parseActivation(null)).toEqual([]);
    expect(parseActivation(undefined)).toEqual([]);
    expect(parseActivation("")).toEqual([]);
    expect(serializeActivation([])).toBe("");
  });

  it("survives whitespace and stray commas", () => {
    expect(parseActivation(" github , ,notion,")).toEqual([
      "github",
      "notion",
    ]);
  });
});
