import { describe, expect, it } from "vitest";
import {
  MAX_PINNED_ARGS_CHARS,
  bindingCatalogKey,
  bindingScanStrings,
  parseDataBindings,
  publicDataBinding,
  scrubBindingsForClient,
} from "@/lib/app-data-bindings";

const genericBinding = {
  id: "open-prs",
  provider: "github",
  toolName: "list_pull_requests",
  pinnedArgs: { owner: "DadJokez", repo: "AI-workspace", state: "open" },
  label: "Open PRs",
};

const legacyBinding = {
  id: "pipeline",
  provider: "salesforce",
  kind: "soql",
  query: "SELECT Id, Name FROM Opportunity LIMIT 50",
  label: "Pipeline",
};

describe("parseDataBindings", () => {
  it("returns [] for absent, non-object, or non-array dataBindings", () => {
    expect(parseDataBindings(null)).toEqual([]);
    expect(parseDataBindings({})).toEqual([]);
    expect(parseDataBindings("nope")).toEqual([]);
    expect(parseDataBindings({ dataBindings: "not-an-array" })).toEqual([]);
  });

  it("keeps a well-formed generic binding and preserves its fields", () => {
    expect(parseDataBindings({ dataBindings: [genericBinding] })).toEqual([
      genericBinding,
    ]);
  });

  it("reads the legacy #407 SOQL shape as salesforce/run_soql (additive compatibility)", () => {
    expect(parseDataBindings({ dataBindings: [legacyBinding] })).toEqual([
      {
        id: "pipeline",
        provider: "salesforce",
        toolName: "run_soql",
        pinnedArgs: { soql: legacyBinding.query },
        label: "Pipeline",
      },
    ]);
  });

  it("drops malformed entries and fails closed", () => {
    const result = parseDataBindings({
      dataBindings: [
        genericBinding,
        { id: "a", provider: "github", pinnedArgs: {} }, // no toolName
        { id: "b", provider: "github", toolName: "get_issue" }, // no pinnedArgs
        { id: "c", provider: "github", toolName: "get_issue", pinnedArgs: "x" }, // args not an object
        { id: "d", provider: "github", toolName: "get_issue", pinnedArgs: [1] }, // args not an object
        { id: "e", provider: "Git Hub", toolName: "get_issue", pinnedArgs: {} }, // bad provider slug
        { id: "f", provider: "github", toolName: "get issue", pinnedArgs: {} }, // bad tool slug
        { provider: "github", toolName: "get_issue", pinnedArgs: {} }, // no id
        { id: "g", provider: "github", kind: "soql", query: "SELECT Id FROM X" }, // legacy kind on the wrong provider
        { id: "h", provider: "salesforce", kind: "soql", query: "   " }, // empty legacy query
        { id: "i", provider: "salesforce", kind: "graphql", query: "q" }, // unknown kind, no toolName
        genericBinding, // duplicate id collapses to first
      ],
    });
    expect(result).toEqual([genericBinding]);
  });

  it("rejects pinned arguments over the size bound", () => {
    const huge = { ...genericBinding, pinnedArgs: { q: "x".repeat(MAX_PINNED_ARGS_CHARS) } };
    expect(parseDataBindings({ dataBindings: [huge] })).toEqual([]);
  });

  it("truncates an over-long list", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      ...genericBinding,
      id: `b${i}`,
    }));
    expect(parseDataBindings({ dataBindings: many })).toHaveLength(12);
  });
});

describe("bindingScanStrings / bindingCatalogKey", () => {
  it("serializes pinned arguments (nested strings included) for the secret scan", () => {
    const strings = bindingScanStrings({
      dataBindings: [
        legacyBinding,
        {
          ...genericBinding,
          pinnedArgs: { headers: { authorization: "Bearer " + "t".repeat(24) } },
        },
      ],
    });
    expect(strings[0]).toContain(legacyBinding.query);
    expect(strings[1]).toContain("Bearer tttttttttttttttttttttttt");
  });

  it("keys bindings to tools_catalog rows", () => {
    expect(bindingCatalogKey(genericBinding)).toBe("github:list_pull_requests");
  });
});

describe("scrubBindingsForClient / publicDataBinding", () => {
  it("strips pinned arguments but keeps id/provider/toolName/label", () => {
    const scrubbed = scrubBindingsForClient({
      other: "kept",
      dataBindings: [genericBinding, legacyBinding],
    });
    expect(scrubbed).toEqual({
      other: "kept",
      dataBindings: [
        {
          id: "open-prs",
          provider: "github",
          toolName: "list_pull_requests",
          label: "Open PRs",
        },
        {
          id: "pipeline",
          provider: "salesforce",
          toolName: "run_soql",
          label: "Pipeline",
        },
      ],
    });
    // Pinned arguments and query text must never survive serialization.
    const text = JSON.stringify(scrubbed);
    expect(text).not.toContain("Opportunity");
    expect(text).not.toContain("DadJokez");
    expect(text).not.toContain("pinnedArgs");
  });

  it("allowlists fields rather than spreading the binding", () => {
    const withExtra = {
      ...genericBinding,
      secretish: "should not leak",
    } as unknown as Parameters<typeof publicDataBinding>[0];
    expect(publicDataBinding(withExtra)).toEqual({
      id: "open-prs",
      provider: "github",
      toolName: "list_pull_requests",
      label: "Open PRs",
    });
  });

  it("passes through metadata without bindings unchanged", () => {
    expect(scrubBindingsForClient(null)).toBeNull();
    expect(scrubBindingsForClient({ extractedText: "hi" })).toEqual({
      extractedText: "hi",
    });
  });
});
