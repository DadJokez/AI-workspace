import { describe, expect, it } from "vitest";
import { selectSuites } from "./run";
import type { EvalSuite } from "./types";

function testCase(id: string, tags?: readonly string[]) {
  return {
    id,
    description: id,
    input: id,
    ...(tags ? { tags } : {}),
    assertions: [
      {
        kind: "deterministic" as const,
        label: "ok",
        check: () => true,
      },
    ],
  };
}

const suites: EvalSuite[] = [
  {
    capability: "suite-core",
    defaultModelId: "haiku-4-5",
    tags: ["core"],
    cases: [testCase("a"), testCase("b")],
  },
  {
    capability: "case-core",
    defaultModelId: "haiku-4-5",
    cases: [testCase("c", ["core"]), testCase("d", ["advanced"])],
  },
  {
    capability: "advanced-only",
    defaultModelId: "haiku-4-5",
    cases: [testCase("e", ["advanced"])],
  },
];

describe("eval suite selection", () => {
  it("keeps the bare command as the complete suite", () => {
    expect(selectSuites([], suites).map((suite) => suite.capability)).toEqual([
      "suite-core",
      "case-core",
      "advanced-only",
    ]);
    expect(selectSuites([], suites).flatMap((suite) => suite.cases)).toHaveLength(
      5,
    );
  });

  it("selects suite-level and case-level core tags", () => {
    const selected = selectSuites(["--core"], suites);

    expect(selected.map((suite) => suite.capability)).toEqual([
      "suite-core",
      "case-core",
    ]);
    expect(
      selected.map((suite) => [
        suite.capability,
        suite.cases.map((testCase) => testCase.id),
      ]),
    ).toEqual([
      ["suite-core", ["a", "b"]],
      ["case-core", ["c"]],
    ]);
  });

  it("combines a capability filter with core selection", () => {
    expect(
      selectSuites(["case-core", "--core"], suites)[0]?.cases.map(
        (testCase) => testCase.id,
      ),
    ).toEqual(["c"]);
    expect(selectSuites(["advanced-only", "--core"], suites)).toEqual([]);
  });
});
