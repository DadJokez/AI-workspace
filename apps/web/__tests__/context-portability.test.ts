import { describe, expect, it } from "vitest";
import { modelIdentityLine } from "@ai-workspace/agent";
import {
  checkContextPortability,
  formatPortabilityViolations,
  type DurableContextObject,
} from "@ai-workspace/evals/portability";
import { buildAgentPreamble } from "@/lib/agent-preamble";
import { formatArtifactContext } from "@/lib/artifact-context";
import { STARTER_SKILLS } from "@/lib/starter-skills";
import { buildTurnContext } from "@/lib/turn-context";

/**
 * Context-portability gate (issue #304): durable prompt objects must stay
 * provider-neutral so a model swap is a config change, not a rewrite. The
 * deny-list and its rules live in @ai-workspace/evals/portability; this test
 * wires the checker over the real durable objects and runs on every PR via
 * the existing vitest CI step.
 *
 * A neutral test model id below stands in for a future non-Anthropic model.
 * The preamble never states a model at all (#856); the runtime loop injects
 * the single registry-derived identity line, and for an id the registry does
 * not know that line must stay vendor-free — the branded sentence is reserved
 * for turns actually served by a known registry model (identity honesty,
 * which stays intact).
 */

const NEUTRAL_MODEL_ID = "neutral-eval-model-1";

function expectPortable(objects: DurableContextObject[]) {
  const violations = checkContextPortability(objects);
  expect(
    violations,
    formatPortabilityViolations(violations),
  ).toEqual([]);
}

describe("context portability", () => {
  it("starter skills are provider-neutral", () => {
    expectPortable(
      STARTER_SKILLS.map((skill) => ({
        kind: "starter-skill",
        id: skill.slug,
        text: [skill.name, skill.description, skill.systemPrompt].join("\n"),
      })),
    );
  });

  it("agent preamble is provider-neutral — identity belongs to the runtime loop, never durable text", () => {
    const preamble = buildAgentPreamble({
      user: {
        displayName: "Rob",
        assistantName: "Thomas",
        customInstructions: "Prefer short answers.",
        vaultMarkdown: "- Works on the Comparative pilot.",
      },
      connectedProviders: ["github"],
      accountConnectedProviders: ["github", "notion"],
      blockedProviders: ["notion"],
      unavailableProviders: ["google"],
      builtinTools: ["web__fetch_url"],
      vaultContextRequested: true,
    });

    // #856: no model sentence here at all, so nothing can name a vendor.
    expect(preamble).not.toContain("You are powered by");
    expectPortable([
      { kind: "agent-preamble", id: "buildAgentPreamble", text: preamble },
    ]);
  });

  it("runtime identity line is neutral for a model the registry does not know", () => {
    // The loop-injected identity states the actual (neutral) model id and,
    // with no registry entry to draw a brand from, stays vendor-free.
    const line = modelIdentityLine(NEUTRAL_MODEL_ID);
    expect(line).toContain(NEUTRAL_MODEL_ID);
    expectPortable([
      {
        kind: "model-identity-line",
        id: "modelIdentityLine(neutral)",
        text: line,
      },
    ]);
  });

  it("artifact context template is provider-neutral", () => {
    const text = formatArtifactContext({
      artifacts: [
        {
          id: "artifact-1",
          title: "Notes",
          filename: "notes.md",
          kind: "markdown",
        } as never,
      ],
      matched: {
        title: "Notes",
        filename: "notes.md",
        content: "# Notes\nNeutral fixture content.",
      },
      unresolvedReference: false,
      unavailableMatched: { title: "Plan", filename: "plan.md" },
    });

    expectPortable([
      { kind: "context-template", id: "formatArtifactContext", text },
    ]);
  });

  it("turn-context templates (model provenance) are provider-neutral", () => {
    const context = buildTurnContext({
      messages: [
        {
          role: "assistant",
          content: "Earlier answer.",
          modelId: NEUTRAL_MODEL_ID,
        },
        { role: "user", content: "Follow-up question?" },
      ],
    });
    const text = context
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");

    // Provenance reflects the actual model ids from the runtime — with a
    // neutral model in play, no vendor branding may appear anywhere.
    expectPortable([
      { kind: "context-template", id: "buildTurnContext", text },
    ]);
  });

  it("fails when a skill fixture claims a vendor identity", () => {
    const violations = checkContextPortability([
      {
        kind: "skill-row",
        id: "seeded-fixture",
        text: "You are Claude, made by Anthropic.",
      },
    ]);

    expect(violations.length).toBeGreaterThan(0);
    expect(formatPortabilityViolations(violations)).toContain(
      "skill-row:seeded-fixture",
    );
  });
});
