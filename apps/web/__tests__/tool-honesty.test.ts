import { describe, expect, it } from "vitest";
import { renderMcpMountFailureGuidance } from "@ai-workspace/agent";
import { buildAgentPreamble } from "@/lib/agent-preamble";
import {
  INTEGRATION_DISPLAY_NAMES,
  SETTINGS_INTEGRATIONS_PATH,
} from "@/lib/settings-navigation";

/**
 * Tool-use honesty grounding. Born from a real failure: the assistant claimed
 * "no GitHub issues assigned to you" (a fabricated empty result), then a turn
 * later said "I don't actually have access to GitHub" — denying a capability
 * the workspace has. The preamble must forbid both moves on every turn it
 * stamps. Pairs with the conversation-level tool stickiness in chat-routing
 * (which keeps the tool mounted so the contradiction can't arise).
 */
describe("tool-use honesty grounding", () => {
  it("describes chat attachment support without claiming a file was received", () => {
    const preamble = buildAgentPreamble({
      user: { displayName: "Rob", customInstructions: null },
      connectedProviders: [],
    });
    expect(preamble).toContain("this chat accepts supported files");
    expect(preamble).toContain("never say that Comparative cannot receive file uploads");
    expect(preamble).toContain(
      "Never claim to have seen or read a file until its attachment content is actually present",
    );
  });

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

  it("forbids simulated calls and unsupported side-effect claims", () => {
    const preamble = buildAgentPreamble({
      user: { displayName: "Rob", customInstructions: null },
      connectedProviders: [],
    });

    expect(preamble).toContain("External action boundary");
    expect(preamble).toContain("Never emit fake function calls");
    expect(preamble).toContain(
      "unless a successful tool result in this turn proves it",
    );
    expect(preamble).toContain("offer a safe next step");
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
    expect(preamble).toContain(
      "Do not claim you can read, search, write, or summarize these linked tools yet",
    );
    expect(preamble).toContain("do not offer to check them");
    expect(preamble).not.toContain("Connected tools available");
    expect(preamble).not.toContain("No external tools are connected yet");
  });

  it("keeps the 'nothing is broken / coming soon' assurance off non-coming-soon unavailable tools (#323 review)", () => {
    // A provider can be execution-unavailable for a *broken* reason (e.g. a
    // misconfigured Notion endpoint), not just "not shipped yet". Only the
    // coming-soon subset may claim nothing is misconfigured; others must get
    // neutral phrasing so we never hand a genuinely broken tool a false
    // all-clear.
    const preamble = buildAgentPreamble({
      user: { displayName: "Rob", customInstructions: null },
      connectedProviders: [],
      availableProviders: [],
      unavailableProviders: ["notion"],
      comingSoonProviders: [],
    });

    expect(preamble).toContain(
      "chat execution is not enabled for it in this deployment",
    );
    expect(preamble).not.toContain("the integration is coming soon");
    expect(preamble).not.toContain("nothing is broken");
    expect(preamble).not.toContain("no setup step is missing");
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
      comingSoonProviders: ["google"],
    });

    expect(preamble).toContain(
      "Connected account tools linked but not enabled for chat execution",
    );
    expect(preamble).toContain("Google Mail & Calendar");
    expect(preamble).toContain(
      "Do not claim you can read, search, write, or summarize these linked tools yet",
    );
    expect(preamble).toContain("do not offer to check them");
    expect(preamble).toContain("the integration is coming soon");
    expect(preamble).toContain("no setup step is missing");
  });

  it("tells the user to reconnect an expired or under-scoped Google grant", () => {
    const preamble = buildAgentPreamble({
      user: { displayName: "Rob", customInstructions: null },
      connectedProviders: [],
      accountConnectedProviders: ["google"],
      availableProviders: [],
      reconnectRequiredProviders: ["google"],
    });

    expect(preamble).toContain(
      "Connected account tools that require OAuth reconnection",
    );
    expect(preamble).toContain(
      "Google Mail & Calendar needs to be reconnected in Settings → Integrations before I can use it.",
    );
    expect(preamble).toContain("Do not say no tools are connected");
    expect(preamble).not.toContain("No external tools are connected yet");
  });

  it("#713: runtime mount-failure guidance matches the preamble's reconnect copy and the real Settings path", () => {
    // The renderer lives in packages/agent (the dependency direction keeps it
    // from importing settings-navigation), so this pins its hardcoded copy to
    // the canonical constants — a Settings rename must fail this test (#649).
    const guidance = renderMcpMountFailureGuidance([
      {
        provider: "google",
        displayName: INTEGRATION_DISPLAY_NAMES.google,
        message: "invalid_grant",
      },
    ]);
    expect(guidance).toContain(SETTINGS_INTEGRATIONS_PATH);
    expect(guidance).toContain(
      `"${INTEGRATION_DISPLAY_NAMES.google} needs to be reconnected in ${SETTINGS_INTEGRATIONS_PATH} before I can use it."`,
    );
  });

  it("keeps post-call Google guidance out of the cached preamble", () => {
    const preamble = buildAgentPreamble({
      user: { displayName: "Rob", customInstructions: null },
      connectedProviders: ["google"],
      accountConnectedProviders: ["google"],
      availableProviders: ["google"],
    });

    expect(preamble).not.toContain(
      "create_draft saves a Gmail draft and never sends it",
    );
    expect(preamble).not.toContain(
      "created only after a later explicit confirmation turn",
    );
  });

  it("grounds semantic tool selection without keyword routing", () => {
    const preamble = buildAgentPreamble({
      user: { displayName: "Rob", customInstructions: null },
      connectedProviders: ["google"],
      builtinTools: ["web__fetch_url", "web__search"],
    });

    expect(preamble).toContain(
      "call a mounted tool when the answer depends on current public information",
    );
    expect(preamble).toContain(
      "Prefer the connected first-party provider for the user's work data",
    );
    expect(preamble).toContain(
      "Connected account tools represent the user's data, not the assistant's own state or plans",
    );
    expect(preamble).toContain(
      "Do not call a tool for greetings, casual conversation, or self-contained writing",
    );
  });

  it("splits coming-soon and broken providers when both are unavailable (#323 review)", () => {
    const preamble = buildAgentPreamble({
      user: { displayName: "Rob", customInstructions: null },
      connectedProviders: ["github"],
      availableProviders: ["github"],
      unavailableProviders: ["google", "notion"],
      comingSoonProviders: ["google"],
    });

    // Google keeps the reassuring coming-soon copy…
    expect(preamble).toContain("For Google:");
    expect(preamble).toContain("the integration is coming soon");
    // …while Notion gets neutral phrasing with no false all-clear.
    expect(preamble).toContain("For Notion:");
    expect(preamble).toContain(
      "chat execution is not enabled for it in this deployment",
    );
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

  it("advertises discoverable providers as activatable, never denies them (#384 P2)", () => {
    const preamble = buildAgentPreamble({
      user: { displayName: "Rob", customInstructions: null },
      connectedProviders: ["google"],
      discoverableProviders: ["github"],
      accountConnectedProviders: ["google", "github"],
    });

    expect(preamble).toContain("Available via tool discovery");
    expect(preamble).toContain("comparative__activate_tools");
    // The honesty rule for the discoverable set: activate + continue,
    // never call disconnected, never claim an unmounted tool ran.
    expect(preamble).toContain("Never tell the user these are disconnected");
  });
});
