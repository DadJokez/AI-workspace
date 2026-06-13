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
    // The fast lane can stamp a preamble with no mounted providers; the rule
    // must still be present so a tool-less turn can't deny a connected system.
    const preamble = buildAgentPreamble({
      user: { displayName: "Rob", customInstructions: null },
      connectedProviders: [],
      accountConnectedProviders: ["github"],
    });
    expect(preamble).toContain("Honesty about your own capabilities is mandatory");
    expect(preamble).toContain("Connected account tools:");
    expect(preamble).toContain("No connected account tool is mounted");
    expect(preamble).toContain("do not ask the user to refresh");
    expect(preamble).not.toContain("No external tools are connected yet");
  });

  it("does not call pending-approval tools disconnected", () => {
    const preamble = buildAgentPreamble({
      user: { displayName: "Rob", customInstructions: null },
      connectedProviders: [],
      accountConnectedProviders: [],
      blockedProviders: ["github"],
    });
    expect(preamble).toContain("Connected account tools exist");
    expect(preamble).toContain("Connected tools blocked pending approval");
    expect(preamble).not.toContain("No external tools are connected yet");
  });
});
