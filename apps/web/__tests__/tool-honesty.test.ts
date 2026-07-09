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

  it("does not present linked-but-unavailable tools as callable", () => {
    const preamble = buildAgentPreamble({
      user: { displayName: "Rob", customInstructions: null },
      connectedProviders: [],
      availableProviders: [],
      unavailableProviders: ["notion"],
    });

    expect(preamble).toContain(
      "Connected account tools linked but not enabled for chat execution",
    );
    expect(preamble).toContain("Notion: search/read pages");
    expect(preamble).toContain("Do not claim you can use them");
    expect(preamble).toContain("do not offer to check them");
    expect(preamble).toContain("no setup step is missing");
    expect(preamble).not.toContain("Connected tools available");
    expect(preamble).not.toContain("No external tools are connected yet");
  });

  it("frames linked Google as coming soon, not as a broken or callable tool (#323)", () => {
    // The #323 failure: Google OAuth succeeded, the UI said "connected", and
    // the assistant implied it could read Gmail/Calendar while the runtime had
    // no Google tools. The preamble must steer the model to "linked, chat
    // actions coming soon" — never a capability claim, never a setup errand.
    const preamble = buildAgentPreamble({
      user: { displayName: "Rob", customInstructions: null },
      connectedProviders: ["github"],
      availableProviders: ["github"],
      unavailableProviders: ["google"],
    });

    expect(preamble).toContain(
      "Connected account tools linked but not enabled for chat execution",
    );
    expect(preamble).toContain("Google Mail and Calendar");
    expect(preamble).toContain(
      "Do not claim you can read, search, write, or summarize these linked tools yet",
    );
    expect(preamble).toContain("do not offer to check them");
    expect(preamble).toContain("the integration is coming soon");
    expect(preamble).toContain("no setup step is missing");
  });

  it("describes mounted built-in URL fetch without claiming account tools are connected", () => {
    const preamble = buildAgentPreamble({
      user: { displayName: "Rob", customInstructions: null },
      connectedProviders: [],
      builtinTools: ["web__fetch_url"],
    });

    expect(preamble).toContain("Built-in tools mounted for this turn");
    expect(preamble).toContain("Public URL fetch");
    expect(preamble).toContain("No connected account tools are mounted");
    expect(preamble).not.toContain("No external tools are connected yet");
  });
});
