import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface BrowserScenarioContract {
  schemaVersion: number;
  lane: string;
  scenarios: Array<{
    id: string;
    fixture?: string;
    task: string[];
    screenshots: string[];
    assertions: Array<{
      id: string;
      weight: number;
      critical: boolean;
      expected: string;
    }>;
    passThreshold: number;
    criticalFailures: string[];
  }>;
}

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const skillRoot = resolve(
  repoRoot,
  ".agents/skills/comparative-browser-evals",
);
const contractPath = resolve(skillRoot, "references/scenarios.json");
const contract = JSON.parse(
  readFileSync(contractPath, "utf8"),
) as BrowserScenarioContract;

describe("Codex browser eval contract", () => {
  it("keeps two advisory scenarios fail-closed and fully weighted", () => {
    expect(contract.schemaVersion).toBe(1);
    expect(contract.lane).toBe("agentic-browser-advisory");
    expect(contract.scenarios.map((scenario) => scenario.id)).toEqual([
      "CBX-CORE-CSV-001",
      "CBX-CORE-ARTIFACT-001",
    ]);

    for (const scenario of contract.scenarios) {
      expect(scenario.task.length).toBeGreaterThanOrEqual(7);
      expect(scenario.screenshots).toHaveLength(4);
      expect(scenario.assertions.reduce((sum, item) => sum + item.weight, 0)).toBe(
        100,
      );
      expect(scenario.assertions.every((item) => item.critical)).toBe(true);
      expect(scenario.passThreshold).toBe(100);
      expect(scenario.criticalFailures.length).toBeGreaterThanOrEqual(5);
    }
  });

  it("ships the exact synthetic CSV referenced by the browser scenario", () => {
    const csvScenario = contract.scenarios[0]!;
    expect(csvScenario.fixture).toBe("../assets/codex-browser-canary.csv");
    const fixturePath = resolve(
      dirname(contractPath),
      csvScenario.fixture!,
    );
    const rows = readFileSync(fixturePath, "utf8").trim().split("\n");

    expect(rows).toEqual([
      "customer,revenue,region",
      "CODEX_BROWSER_CANARY_7391,48217,East",
      "CONTROL_ROW,19,West",
    ]);
    expect(JSON.stringify(csvScenario)).toContain(
      "CODEX_BROWSER_CANARY_7391",
    );
    expect(JSON.stringify(csvScenario)).toContain("48217");
  });

  it("requires unique run markers for artifact creation and revision", () => {
    const artifactScenario = contract.scenarios[1]!;
    const serialized = JSON.stringify(artifactScenario);

    expect(serialized).toContain("codex-browser-{RUN_ID}.html");
    expect(serialized).toContain("ALPHA_{RUN_ID}");
    expect(serialized).toContain("REV_{RUN_ID}");
    expect(serialized).toContain("Revise the existing");
    expect(serialized).toContain("Keep the same filename");
  });
});
