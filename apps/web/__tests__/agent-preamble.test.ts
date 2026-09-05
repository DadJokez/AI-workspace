import { describe, expect, it } from "vitest";
import { buildAgentPreamble } from "@/lib/agent-preamble";

/**
 * The honesty spine (rubric priority 3), asserted directly on the grounding
 * lines of buildAgentPreamble rather than incidentally through other suites:
 * the assistant must name the real product, must leave the model/vendor
 * sentence to the runtime loop's single registry-derived line (#856, #304 —
 * pinned in packages/agent/src/model-identity.test.ts), and must leave date
 * grounding to the runtime loop's volatile suffix — never the cached prefix
 * (see date-grounding.test.ts for the loop half of both contracts).
 */

function minimalPreamble(overrides: { assistantName?: string | null } = {}) {
  return buildAgentPreamble({
    user: {
      displayName: "Rob",
      assistantName: overrides.assistantName ?? null,
      customInstructions: null,
    },
    connectedProviders: [],
  });
}

describe("buildAgentPreamble identity grounding", () => {
  it("names the real product and defaults the assistant name to it", () => {
    const preamble = minimalPreamble();
    expect(preamble).toContain(
      "You are Comparative, Rob's internal AI assistant inside Comparative.",
    );
    expect(preamble).toContain("Comparative is the workspace/product name");
    expect(preamble).toContain('If asked your name, answer "Comparative"');
  });

  it("keeps product grounding when the user has renamed the assistant", () => {
    const preamble = minimalPreamble({ assistantName: "Thomas" });
    expect(preamble).toContain("You are Thomas");
    expect(preamble).toContain('If asked your name, answer "Thomas"');
    // The product itself is never renamed along with the assistant.
    expect(preamble).toContain("Comparative is the workspace/product name");
  });
});

describe("buildAgentPreamble model grounding", () => {
  it("leaves the identity sentence to the runtime loop — the preamble never states a model or vendor (#856)", () => {
    // `runAgentLoop` prepends the one registry-derived `modelIdentityLine`
    // to the stable prompt; a second copy here would double the sentence
    // and put a vendor into durable text (#304). The loop half is pinned in
    // date-grounding.test.ts; the wording in model-identity.test.ts.
    const preamble = minimalPreamble();
    expect(preamble).not.toContain("You are powered by");
    expect(preamble).not.toContain("Anthropic");
    expect(preamble).not.toContain("Claude");
  });
});

describe("buildAgentPreamble date grounding", () => {
  it("never carries the clock — date grounding belongs to the runtime's volatile suffix", () => {
    // The preamble travels in the cached Bedrock prompt prefix; a timestamp
    // here would defeat prompt caching AND go stale inside a conversation.
    // runAgentLoop stamps "Current date and time (UTC):" after the cache
    // checkpoint on every turn (packages/agent/src/loop.ts).
    const preamble = minimalPreamble();
    expect(preamble).not.toContain("Current date and time");
    expect(preamble).not.toContain(new Date().toISOString().slice(0, 10));
  });
});

describe("buildAgentPreamble fact fidelity", () => {
  it("preserves factual state and modal strength during rewrites", () => {
    const preamble = minimalPreamble();
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
    });

    expect(preamble).not.toContain("Google write boundary");
    expect(preamble).not.toContain("Live-data pages:");
    // Selection and pre-call schema grounding still belong before a call.
    expect(preamble).toContain("Salesforce schema grounding");
  });
});

describe("buildAgentPreamble settings navigation grounding (#649)", () => {
  it("points a fresh account at the real Integrations path, never an invented page", () => {
    const preamble = minimalPreamble();
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
    expect(preamble).toContain("use an ungrouped aggregate such as SUM() or COUNT()");
    expect(preamble).toContain(
      "Never infer an org-wide total by summing a record query",
    );
    expect(preamble).toContain(
      "may be truncated even when done is true and records.length equals totalSize",
    );
    expect(preamble).toContain(
      "make the first corrected query the required ungrouped aggregate",
    );
  });
});

describe("buildAgentPreamble artifact boundary", () => {
  it("#647 draws the formatting-in-chat vs document-creation line", () => {
    const preamble = minimalPreamble();
    expect(preamble).toContain(
      "A request to FORMAT your answer is not a file request",
    );
    expect(preamble).toContain("answer inline in ordinary chat Markdown");
    // The file path still exists for genuine document requests.
    expect(preamble).toContain(
      "return the complete finished file contents in a fenced code block",
    );
  });
});

describe("buildAgentPreamble connected-but-not-mounted honesty", () => {
  const lightweightPreamble = () =>
    buildAgentPreamble({
      user: {
        displayName: "Rob",
        assistantName: null,
        customInstructions: null,
      },
      // Connected on the account, nothing mounted on this fast-chat turn.
      accountConnectedProviders: ["github"],
      connectedProviders: [],
    });

  it("forbids narrating a lookup the turn cannot perform", () => {
    const preamble = lightweightPreamble();

    expect(preamble).toContain(
      "No connected account tool is mounted in this lightweight turn",
    );
    // The regression (#641): "Say you need to check it" produced "Let me
    // fetch your last 3 pull requests" followed by invented PRs. The lane
    // has no tool to contradict the fabrication, so the prompt must name
    // the absent action instead of inviting it.
    expect(preamble).not.toContain("Say you need to check it");
    expect(preamble).toContain(
      "do not write that you are fetching, checking, looking up, searching, or retrieving anything",
    );
    expect(preamble).toContain("do not emit tool-call syntax");
  });

  it("clamps the correction so it cannot deny the account itself", () => {
    const preamble = lightweightPreamble();

    expect(preamble).toContain(
      "the account is connected but no tool is mounted on this turn to reach it",
    );
    expect(preamble).toContain(
      "Never say the account itself is not connected, not available, or not accessible",
    );
  });
});
