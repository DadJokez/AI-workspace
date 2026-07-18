import { describe, expect, it } from "vitest";
import {
  bindingQueryStrings,
  findDataBinding,
  parseDataBindings,
  scrubBindingsForClient,
} from "@/lib/app-data-bindings";

const goodBinding = {
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

  it("keeps a well-formed binding and preserves its fields", () => {
    expect(parseDataBindings({ dataBindings: [goodBinding] })).toEqual([
      goodBinding,
    ]);
  });

  it("drops malformed entries and fails closed", () => {
    const result = parseDataBindings({
      dataBindings: [
        goodBinding,
        { id: "x", provider: "github", kind: "soql", query: "q" }, // unsupported provider
        { id: "y", provider: "salesforce", kind: "graphql", query: "q" }, // wrong kind
        { id: "z", provider: "salesforce", kind: "soql", query: "  " }, // empty query
        { provider: "salesforce", kind: "soql", query: "q" }, // no id
        goodBinding, // duplicate id collapses to first
      ],
    });
    expect(result).toEqual([goodBinding]);
  });

  it("truncates an over-long list", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      ...goodBinding,
      id: `b${i}`,
    }));
    expect(parseDataBindings({ dataBindings: many })).toHaveLength(12);
  });
});

describe("findDataBinding / bindingQueryStrings", () => {
  it("finds by id and returns null for a miss", () => {
    const meta = { dataBindings: [goodBinding] };
    expect(findDataBinding(meta, "pipeline")?.query).toContain("Opportunity");
    expect(findDataBinding(meta, "missing")).toBeNull();
  });

  it("collects query strings for the mint secret scan", () => {
    expect(
      bindingQueryStrings({
        dataBindings: [goodBinding, { ...goodBinding, id: "b2", query: "SELECT Id FROM Account" }],
      }),
    ).toEqual([goodBinding.query, "SELECT Id FROM Account"]);
  });
});

describe("scrubBindingsForClient", () => {
  it("strips the raw query but keeps id/provider/kind/label", () => {
    const scrubbed = scrubBindingsForClient({
      other: "kept",
      dataBindings: [goodBinding],
    });
    expect(scrubbed).toEqual({
      other: "kept",
      dataBindings: [
        { id: "pipeline", provider: "salesforce", kind: "soql", label: "Pipeline" },
      ],
    });
    // The query text must never survive serialization to a viewer.
    expect(JSON.stringify(scrubbed)).not.toContain("Opportunity");
  });

  it("passes through metadata without bindings unchanged", () => {
    expect(scrubBindingsForClient(null)).toBeNull();
    expect(scrubBindingsForClient({ extractedText: "hi" })).toEqual({
      extractedText: "hi",
    });
  });
});
