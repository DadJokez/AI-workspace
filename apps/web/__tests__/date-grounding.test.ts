import { describe, expect, it } from "vitest";
import type { BedrockClient, BedrockStreamEvent } from "@ai-workspace/agent";
import { BedrockRuntime } from "@ai-workspace/cursor-runtime";
import { buildAgentPreamble } from "@/lib/agent-preamble";

/**
 * Date grounding: models have no reliable sense of "now". Every Bedrock-path
 * turn (fast chat, tool turns, the AgentCore container — all share
 * runAgentLoop) must carry the real clock in its system prompt, and the
 * Cursor-lane preamble must carry it too. Born from a real failure:
 * "31 days until Christmas 2024", answered in mid-June 2026.
 */
class CaptureClient implements BedrockClient {
  systemPrompt: string | undefined;

  async *converseStream(params: {
    systemPrompt?: string;
  }): AsyncIterable<BedrockStreamEvent> {
    this.systemPrompt = params.systemPrompt;
    yield { type: "text-delta", text: "ok" } as BedrockStreamEvent;
    yield { type: "stop", reason: "end_turn" } as BedrockStreamEvent;
  }
}

describe("date grounding", () => {
  it("stamps the current UTC date into every Bedrock turn", async () => {
    const client = new CaptureClient();
    const runtime = new BedrockRuntime({ client });
    for await (const _ev of runtime.runTurn({
      threadId: "t1",
      modelId: "haiku-4-5",
      messages: [{ role: "user", content: "is it christmas?" }],
      context: { userId: "u1" },
    })) {
      // drain
    }
    expect(client.systemPrompt).toContain("Current date and time (UTC):");
    expect(client.systemPrompt).toContain(
      new Date().toISOString().slice(0, 10),
    );
    // Identity grounding: the model must know which model it is.
    expect(client.systemPrompt).toContain("You are Claude Haiku 4.5");
    expect(client.systemPrompt).toContain("never claim to be an older model");
  });

  it("keeps the caller's system prompt after the date stamp (skill runs)", async () => {
    const client = new CaptureClient();
    const runtime = new BedrockRuntime({ client });
    for await (const _ev of runtime.runTurn({
      threadId: "t1",
      modelId: "haiku-4-5",
      systemPrompt: "You are the christmas checker.",
      messages: [{ role: "user", content: "well?" }],
      context: { userId: "u1" },
    })) {
      // drain
    }
    expect(client.systemPrompt).toContain("Current date and time (UTC):");
    expect(client.systemPrompt).toContain("You are the christmas checker.");
  });

  it("grounds the Cursor-lane preamble and scopes the slash note to literal '/' messages", () => {
    const preamble = buildAgentPreamble({
      user: { displayName: "Rob", customInstructions: null },
      connectedProviders: ["github"],
    });
    expect(preamble).toContain("Current date and time (UTC):");
    expect(preamble).toContain('literally starts with "/"');
    expect(preamble).toContain(
      "when you are already executing a skill's instructions, just do the work",
    );
  });

  it("grounds the assistant's model identity in the preamble", () => {
    const preamble = buildAgentPreamble({
      user: { displayName: "Rob", customInstructions: null },
      connectedProviders: [],
      modelId: "sonnet-4-6",
    });
    expect(preamble).toContain("Claude Sonnet 4.6");
    expect(preamble).toContain("Comparative");
    expect(preamble).toContain('never claim to be an older model such as "Claude 3.5"');
  });

  it("uses the user's configured assistant name instead of the product name", () => {
    const preamble = buildAgentPreamble({
      user: {
        displayName: "Rob",
        assistantName: "Thomas",
        customInstructions: null,
      },
      connectedProviders: [],
      modelId: "sonnet-4-6",
    });

    expect(preamble).toContain("You are Thomas");
    expect(preamble).toContain('If asked your name, answer "Thomas"');
    expect(preamble).toContain("Comparative is the workspace/product name");
  });
});
