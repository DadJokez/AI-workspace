import { describe, expect, it } from "vitest";
import { filterAttestedProviders } from "@/lib/tool-attestations";

describe("filterAttestedProviders", () => {
  it("allows providers with active provider-scope attestations", () => {
    expect(
      filterAttestedProviders(["github"], [
        {
          provider: "github",
          scopeType: "provider",
          category: null,
          toolName: null,
          action: "admin",
        },
      ]),
    ).toEqual({
      allowedProviders: ["github"],
      deniedProviders: [],
    });
  });

  it("denies connected providers without provider-scope approval", () => {
    expect(filterAttestedProviders(["github"], [])).toEqual({
      allowedProviders: [],
      deniedProviders: ["github"],
    });
  });

  it("does not mount a whole provider for only category or tool attestations", () => {
    expect(
      filterAttestedProviders(["github"], [
        {
          provider: "github",
          scopeType: "tool",
          category: null,
          toolName: "list_pull_requests",
          action: "read",
        },
        {
          provider: "github",
          scopeType: "category",
          category: "repos",
          toolName: null,
          action: "read",
        },
      ]),
    ).toEqual({
      allowedProviders: [],
      deniedProviders: ["github"],
    });
  });
});
