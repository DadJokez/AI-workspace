import { describe, expect, it } from "vitest";
import {
  PINNED_PRECEDENCE_NOTE,
  renderPinnedActiveSkill,
  renderPinnedOrgInstructions,
  renderSkillOverPersonalNote,
} from "@ai-workspace/agent";
import type { TurnTranscript } from "../types";
import {
  CBX_PERSONAL_LAYER,
  CBX_RECEIPT_LABEL,
  CBX_SENTINELS,
  CBX_SKILL,
  CBX_SYSTEM_PROMPT,
  bulletLines,
  bulletsOpeningWith,
  instructionPrecedenceSuite,
  proseLines,
} from "./instruction-precedence.cases";

const COMPLIANT_ANSWER = [
  "- CBX-ONE: Juniper, pair every new hire with an onboarding buddy for the first two weeks.",
  "- **CBX-TWO:** Replace the static checklist with a dated task list owned by the hiring manager.",
  "- CBX-THREE: Add a day-30 retrospective so the checklist improves from real feedback.",
].join("\n");

// The shape of the CBX-20260724-091510 production answer: two bullets, the
// third sentinel dropped, prose added — the Vault fact won.
const CBX_REGRESSION_ANSWER = [
  "Hi Juniper — here are my two recommendations:",
  "- CBX-ONE: Pair every new hire with an onboarding buddy.",
  "- CBX-TWO: Add a day-30 retrospective.",
  "Let me know if you want me to expand on either.",
].join("\n");

function transcript(answer: string): TurnTranscript {
  const testCase = instructionPrecedenceSuite.cases[0]!;
  return {
    answer,
    events: [],
    toolCallNames: [],
    toolResults: [],
    contextReceipts: testCase.contextReceipts ?? [],
    fixtureEvidence: [],
  };
}

function runDeterministic(answer: string) {
  const testCase = instructionPrecedenceSuite.cases[0]!;
  return testCase.assertions.map((assertion) => {
    if (assertion.kind !== "deterministic") throw new Error("judge-free case");
    const result = assertion.check(transcript(answer));
    return [assertion.label, typeof result === "boolean" ? result : result.ok] as const;
  });
}

describe("instruction-precedence eval (#438, CBX-20260724-091510)", () => {
  it("assembles the prompt from the production layer helpers, in production order", () => {
    expect(CBX_SYSTEM_PROMPT).toContain(PINNED_PRECEDENCE_NOTE);
    expect(CBX_SYSTEM_PROMPT).toContain(renderPinnedOrgInstructions(null));
    expect(CBX_SYSTEM_PROMPT).toContain(renderPinnedActiveSkill(CBX_SKILL));
    const vault = CBX_SYSTEM_PROMPT.indexOf("address me as Juniper");
    const note = CBX_SYSTEM_PROMPT.indexOf(PINNED_PRECEDENCE_NOTE);
    const org = CBX_SYSTEM_PROMPT.indexOf("Organization standing instructions (layer 3)");
    const skill = CBX_SYSTEM_PROMPT.indexOf("<<<PINNED-ACTIVE-SKILL>>>");
    expect(vault).toBeGreaterThan(0);
    expect(note).toBeGreaterThan(vault);
    expect(org).toBeGreaterThan(note);
    expect(skill).toBeGreaterThan(org);
  });

  it("states the #911 skill-over-personal conflict right above the Vault text, naming only the source this prompt renders", () => {
    // The prompt has a Vault section and no custom instructions, so the
    // line must name exactly that — the same input the preamble derives.
    const line = renderSkillOverPersonalNote(CBX_PERSONAL_LAYER)!;
    expect(line).toContain("(the user's approved Vault memory)");
    expect(line).not.toContain("custom instructions and");
    const at = CBX_SYSTEM_PROMPT.indexOf(line);
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(CBX_SYSTEM_PROMPT.indexOf("Personal context approved by the user:"));
    expect(CBX_SYSTEM_PROMPT.split("Precedence for this skill run").length - 1).toBe(1);
  });

  it("pins the skill's contract to an explicit Markdown marker, which the assertions require", () => {
    expect(CBX_SKILL.systemPrompt).toContain('each starting with "- "');
    for (const sentinel of CBX_SENTINELS) {
      expect(CBX_SKILL.systemPrompt).toContain(`"- ${sentinel} …"`);
    }
  });

  it("fails the 2026-09-06 nightly shape: two sentinel paragraphs, no markers, no third sentinel (#911)", () => {
    const nightly = [
      "CBX-ONE: Add a structured 30-60-90 day milestone framework with specific deliverables.",
      "",
      "CBX-TWO: Include dedicated time blocks for new hires to shadow team members.",
    ].join("\n");
    const results = new Map(runDeterministic(nightly));
    expect(
      results.get("all three skill sentinels are present, each opening exactly one bullet"),
    ).toBe(false);
    expect(
      results.get(
        "exactly three bullets — the skill's format beats the Vault's two-bullet preference",
      ),
    ).toBe(false);
    expect(results.get("no prose outside the bullets (the CBX run added prose)")).toBe(false);
  });

  it("declares the receipt row the product renders for both layers", () => {
    expect(CBX_RECEIPT_LABEL).toBe(
      "Instructions · Skill: CBX Three-Bullet Recommendations · 1 Vault memory · Org: not configured",
    );
    expect(instructionPrecedenceSuite.cases[0]!.contextReceipts).toContain(CBX_RECEIPT_LABEL);
  });

  it("is judge-free so the --mock lane and nightly both run it deterministically", () => {
    for (const assertion of instructionPrecedenceSuite.cases[0]!.assertions) {
      expect(assertion.kind).toBe("deterministic");
    }
  });

  it("passes a compliant three-sentinel answer, tolerating Markdown emphasis", () => {
    expect(bulletLines(COMPLIANT_ANSWER)).toHaveLength(3);
    expect(proseLines(COMPLIANT_ANSWER)).toEqual([]);
    for (const sentinel of CBX_SENTINELS) {
      expect(bulletsOpeningWith(COMPLIANT_ANSWER, sentinel)).toBe(1);
    }
    expect(runDeterministic(COMPLIANT_ANSWER).every(([, ok]) => ok)).toBe(true);
  });

  it("fails the CBX-shaped regression: two bullets, missing sentinel, added prose", () => {
    const results = new Map(runDeterministic(CBX_REGRESSION_ANSWER));
    expect(
      results.get("all three skill sentinels are present, each opening exactly one bullet"),
    ).toBe(false);
    expect(
      results.get(
        "exactly three bullets — the skill's format beats the Vault's two-bullet preference",
      ),
    ).toBe(false);
    expect(results.get("no prose outside the bullets (the CBX run added prose)")).toBe(false);
    expect(results.get("the receipt names both the skill and the Vault layers")).toBe(true);
  });

  it("does not count a sentinel that appears mid-bullet or in prose", () => {
    const sneaky = [
      "- Pair new hires with a buddy CBX-ONE:",
      "CBX-TWO: not a bullet",
      "- CBX-THREE: Add a retrospective.",
    ].join("\n");
    expect(bulletsOpeningWith(sneaky, "CBX-ONE:")).toBe(0);
    expect(bulletsOpeningWith(sneaky, "CBX-TWO:")).toBe(0);
    expect(bulletsOpeningWith(sneaky, "CBX-THREE:")).toBe(1);
  });
});
