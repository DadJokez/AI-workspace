import { describe, expect, it } from "vitest";
import { MODEL_IDS, MODELS } from "@ai-workspace/agent";
import { buildAgentPreamble } from "@/lib/agent-preamble";

/**
 * The honesty spine (rubric priority 3), asserted directly on the grounding
 * lines of buildAgentPreamble rather than incidentally through other suites:
 * the assistant must name the real product, must never claim a wrong model or
 * a vendor the turn may not be running on (#304), and must leave date
 * grounding to the runtime loop's volatile suffix — never the cached prefix
 * (see date-grounding.test.ts for the loop half of that contract).
 */

function minimalPreamble(overrides: {
  modelId?: string;
  assistantName?: string | null;
} = {}) {
  return buildAgentPreamble({
    user: {
      displayName: "Rob",
      assistantName: overrides.assistantName ?? null,
      customInstructions: null,
    },
    connectedProviders: [],
    ...(overrides.modelId !== undefined ? { modelId: overrides.modelId } : {}),
  });
}

describe("buildAgentPreamble identity grounding", () => {
  it("names the real product and defaults the assistant name to it", () => {
    const preamble = minimalPreamble({ modelId: "sonnet-4-6" });
    expect(preamble).toContain(
      "You are Comparative, Rob's internal AI assistant inside Comparative.",
    );
    expect(preamble).toContain("Comparative is the workspace/product name");
    expect(preamble).toContain('If asked your name, answer "Comparative"');
  });

  it("keeps product grounding when the user has renamed the assistant", () => {
    const preamble = minimalPreamble({
      modelId: "sonnet-4-6",
      assistantName: "Thomas",
    });
    expect(preamble).toContain("You are Thomas");
    expect(preamble).toContain('If asked your name, answer "Thomas"');
    // The product itself is never renamed along with the assistant.
    expect(preamble).toContain("Comparative is the workspace/product name");
  });
});

describe("buildAgentPreamble model grounding", () => {
  it.each(MODEL_IDS)(
    "%s: states the real branded model and forbids claiming an older one",
    (modelId) => {
      const preamble = minimalPreamble({ modelId });
      const { displayName } = MODELS[modelId];
      expect(preamble).toContain(
        `You are powered by Claude ${displayName}, made by Anthropic.`,
      );
      expect(preamble).toContain(
        `answer "Claude ${displayName}" — never claim to be an older model such as "Claude 3.5"`,
      );
      // And never any OTHER registry model's name.
      for (const otherId of MODEL_IDS) {
        if (otherId === modelId) continue;
        expect(preamble).not.toContain(MODELS[otherId].displayName);
      }
    },
  );

  it("gives an unknown model id a neutral identity with no hardcoded vendor (#304)", () => {
    const preamble = minimalPreamble({ modelId: "candidate-model-x" });
    expect(preamble).toContain(
      'You are powered by the model registered as "candidate-model-x".',
    );
    expect(preamble).toContain(
      'answer "candidate-model-x" — never claim to be a different model or vendor',
    );
    // Durable text must not claim Anthropic/Claude for a turn that may not
    // be running on either.
    expect(preamble).not.toContain("Anthropic");
    expect(preamble).not.toContain("Claude");
  });

  it("with no model reported, instructs honesty instead of a guess", () => {
    const preamble = minimalPreamble();
    expect(preamble).toContain(
      "say the runtime did not report a model for this turn — never guess or claim a specific model or vendor",
    );
    expect(preamble).not.toContain("You are powered by");
  });
});

describe("buildAgentPreamble date grounding", () => {
  it("never carries the clock — date grounding belongs to the runtime's volatile suffix", () => {
    // The preamble travels in the cached Bedrock prompt prefix; a timestamp
    // here would defeat prompt caching AND go stale inside a conversation.
    // runAgentLoop stamps "Current date and time (UTC):" after the cache
    // checkpoint on every turn (packages/agent/src/loop.ts).
    const preamble = minimalPreamble({ modelId: "sonnet-4-6" });
    expect(preamble).not.toContain("Current date and time");
    expect(preamble).not.toContain(new Date().toISOString().slice(0, 10));
  });
});

describe("buildAgentPreamble fact fidelity", () => {
  it("preserves factual state and modal strength during rewrites", () => {
    const preamble = minimalPreamble({ modelId: "sonnet-4-6" });
    expect(preamble).toContain("Fact fidelity:");
    expect(preamble).toContain(
      "do not turn limited or restricted work into blocked, delayed, completed, approved, or unable-to-proceed work",
    );
  });
});

describe("buildAgentPreamble just-in-time tool guidance", () => {
  it("keeps provider post-call rules out of the cached system prefix", () => {
    const preamble = buildAgentPreamble({
      user: { displayName: "Rob", customInstructions: null },
      connectedProviders: ["google", "salesforce"],
      modelId: "sonnet-4-6",
    });

    expect(preamble).not.toContain("Google write boundary");
    expect(preamble).not.toContain("Live-data pages:");
    // Selection and pre-call schema grounding still belong before a call.
    expect(preamble).toContain("Salesforce schema grounding");
  });
});

describe("buildAgentPreamble settings navigation grounding (#649)", () => {
  it("points a fresh account at the real Integrations path, never an invented page", () => {
    const preamble = minimalPreamble({ modelId: "sonnet-4-6" });
    expect(preamble).toContain(
      "No external tools are connected yet. The user can connect one in Settings → Integrations.",
    );
    // The canonical, visible click path for GitHub — the exact labels the
    // Settings UI renders (shared constant, cannot drift).
    expect(preamble).toContain(
      "Settings → Integrations → GitHub → Connect GitHub",
    );
    // The invented page from #649 and the old nonexistent section name.
    expect(preamble).not.toContain("Connected Accounts");
    expect(preamble).not.toContain("Tools section");
  });

  it("keeps the canonical connect path when other providers are connected", () => {
    const preamble = buildAgentPreamble({
      user: { displayName: "Rob", customInstructions: null },
      connectedProviders: ["google"],
      modelId: "sonnet-4-6",
    });
    // A user with Google connected but GitHub disconnected still needs the
    // real path instead of model improvisation.
    expect(preamble).toContain(
      "Settings → Integrations → GitHub → Connect GitHub",
    );
    expect(preamble).toContain(
      "Never invent settings pages or section names that are not stated here.",
    );
    expect(preamble).not.toContain("Connected Accounts");
  });
});

describe("buildAgentPreamble Salesforce schema grounding", () => {
  it("requires describe evidence before correcting an INVALID_FIELD query", () => {
    const preamble = buildAgentPreamble({
      user: {
        displayName: "Rob",
        assistantName: null,
        customInstructions: null,
      },
      connectedProviders: ["salesforce"],
    });

    expect(preamble).toContain("Salesforce schema grounding");
    expect(preamble).toContain("salesforce__describe_object");
    expect(preamble).toContain("do not retry identical SOQL");
  });
});
