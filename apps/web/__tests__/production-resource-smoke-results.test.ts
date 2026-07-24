import { describe, expect, it } from "vitest";

import { partitionResourceToolResults } from "@/scripts/production-resource-smoke-results";

describe("production resource smoke result classification (#576)", () => {
  it("requires receipts only from successful resource calls", () => {
    const successful = {
      provider: "resources",
      name: "resources__query",
      isError: false,
      output: { receipt: { sourceCoverage: "full" } },
    };
    const correctedFailure = {
      provider: "resources",
      name: "resources__query",
      isError: true,
      output: { redacted: true },
    };

    expect(
      partitionResourceToolResults([successful, correctedFailure]),
    ).toEqual({
      all: [successful, correctedFailure],
      successful: [successful],
    });
  });

  it("retains legacy successful results that omit isError", () => {
    const legacy = {
      name: "resources__query",
      output: { receipt: { sourceCoverage: "full" } },
    };

    expect(partitionResourceToolResults([legacy]).successful).toEqual([
      legacy,
    ]);
  });

  it("ignores unrelated tool results", () => {
    const webResult = {
      provider: "web",
      name: "web__search",
      isError: false,
    };

    expect(partitionResourceToolResults([webResult])).toEqual({
      all: [],
      successful: [],
    });
  });
});
