import { describe, expect, it } from "vitest";
import { withToolHistory } from "./tool-history-config";
import type { BedrockMessage } from "./clients";

const history: BedrockMessage[] = [
  { role: "assistant", content: [{ kind: "tool-use", id: "one", name: "lookup", input: {} }] },
  { role: "user", content: [{ kind: "tool-result", toolUseId: "one", content: "value" }] },
];
describe("history-only tool schemas", () => {
  it("does not add tools when history has none", () => {
    expect(withToolHistory(undefined, [])).toBeUndefined();
  });
  it("supplies schemas for unmounted historical tools", () => {
    const config = withToolHistory(undefined, history);
    expect(config?.tools.map((tool) => tool.toolSpec.name)).toEqual(["lookup"]);
    expect(config?.tools[0]?.toolSpec.description).toContain("Unavailable for execution");
    expect(config?.toolChoice).toBeUndefined();
  });
  it("reuses mounted configurations and deduplicates history", () => {
    const config = withToolHistory(undefined, history)!;
    expect(withToolHistory(config, [...history, ...history])).toBe(config);
  });
  it("keeps the API toolConfig invariant even for result-only history", () => {
    expect(withToolHistory(undefined, [history[1]!])?.tools).toHaveLength(1);
  });
});
