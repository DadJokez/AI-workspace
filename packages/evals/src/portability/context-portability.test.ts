import { describe, expect, it } from "vitest";
import {
  checkContextPortability,
  formatPortabilityViolations,
} from "./context-portability";

describe("checkContextPortability", () => {
  it("fails a skill body claiming to be Claude, pointing at the offending object", () => {
    const violations = checkContextPortability([
      {
        kind: "skill-row",
        id: "poisoned-fixture-skill",
        text: "You are Claude, made by Anthropic. Summarize the standup notes.",
      },
    ]);

    // Both the model-family and the provider reference are reported.
    expect(violations.length).toBeGreaterThanOrEqual(2);
    expect(violations[0]).toMatchObject({
      kind: "skill-row",
      id: "poisoned-fixture-skill",
    });
    const formatted = formatPortabilityViolations(violations);
    expect(formatted).toContain("skill-row:poisoned-fixture-skill");
    expect(formatted).toContain("You are Claude");
  });

  it("flags competitor references and Anthropic tag conventions", () => {
    const violations = checkContextPortability([
      { kind: "starter-skill", id: "a", text: "Answer like ChatGPT would." },
      { kind: "starter-skill", id: "b", text: "Wrap plans in <thinking> tags." },
      { kind: "starter-skill", id: "c", text: "Prefer GPT-4 style prose." },
    ]);

    expect(violations.map((v) => v.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("allows registry model ids as config vocabulary", () => {
    const violations = checkContextPortability([
      {
        kind: "starter-skill",
        id: "skill-creator",
        text: "Choose `model`: **haiku-4-5** for short tasks, **sonnet-4-6** for reasoning. Emit `model: sonnet-4-6`.",
      },
    ]);

    expect(violations).toEqual([]);
  });

  it("allows neutral durable text", () => {
    const violations = checkContextPortability([
      {
        kind: "agent-preamble",
        id: "buildAgentPreamble(neutral)",
        text: "You are the user's internal assistant. If asked which model you are, answer with the model id reported by the runtime.",
      },
    ]);

    expect(violations).toEqual([]);
  });
});
