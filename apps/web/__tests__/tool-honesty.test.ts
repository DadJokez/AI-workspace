import { describe, expect, it } from "vitest";
import { buildAgentPreamble } from "@/lib/agent-preamble";

/**
 * Tool-use honesty grounding. Born from a real failure: the assistant claimed
 * "no GitHub issues assigned to you" (a fabricated empty result), then a turn
 * later said "I don't actually have access to GitHub" — denying a capability
 * the workspace has. The preamble must forbid both moves on every turn it
 * stamps. Pairs with the conversation-level tool stickiness in chat-routing
 * (which keeps the tool mounted so the contradiction can't arise).
 */
describe("tool-use honesty grounding", () => {
  it("forbids denying access to connected systems", () => {
    const preamble = buildAgentPreamble({
      user: { displayName: "Rob", customInstructions: null },
      connectedProviders: ["github"],
    });
    expect(preamble).toContain("Honesty about your own capabilities is mandatory");
    expect(preamble).toContain("never deny a capability this workspace has");
  });

  it("forbids inventing empty tool results and requires stating the query scope", () => {
    const preamble = buildAgentPreamble({
      user: { displayName: "Rob", customInstructions: null },
      connectedProviders: ["github"],
    });
    expect(preamble).toContain("Never invent a tool result you did not actually receive");
    expect(preamble).toContain("state exactly what you queried");
  });

  it("keeps the honesty rule even when no tools are mounted this turn", () => {
    // The fast lane can stamp a preamble with no connected providers; the rule
    // must still be present so a tool-less turn can't deny a connected system.
    const preamble = buildAgentPreamble({
      user: { displayName: "Rob", customInstructions: null },
      connectedProviders: [],
    });
    expect(preamble).toContain("Honesty about your own capabilities is mandatory");
  });

  it("distinguishes connected account tools from tools mounted on a lightweight turn", () => {
    const preamble = buildAgentPreamble({
      user: { displayName: "Rob", customInstructions: null },
      connectedProviders: [],
      availableProviders: ["github"],
    });

    expect(preamble).toContain("Connected tools available");
    expect(preamble).toContain("GitHub: repositories");
    expect(preamble).toContain("Do not say no tools are connected");
    expect(preamble).not.toContain("No external tools are connected yet");
  });
});
