import { describe, expect, it } from "vitest";

import {
  runAgentLoop,
  ToolRegistry,
  type BedrockClient,
  type BedrockStreamEvent,
  type ConverseStreamParams,
} from "@ai-workspace/agent";
import type { PreparedChatAttachment } from "@/lib/attachments";
import { buildConversationResourcePrompt } from "@/lib/conversation-resource-prompt";
import {
  preparePendingConversationResources,
  resolveConversationResources,
  type ConversationResourceResolution,
} from "@/lib/conversation-resources";
import { buildTurnContext } from "@/lib/turn-context";

describe("conversation resource prompt planning (#609, #613)", () => {
  it("keeps file bytes out of every agent step while preserving history", async () => {
    const attachment = preparedAttachment(
      "orders.csv",
      "order_id,total\n" + "1,42\n".repeat(30_000),
    );
    const plan = buildConversationResourcePrompt({
      message: "Settle the claims from our earlier analysis.",
      attachments: [attachment],
      resourceIds: ["resource-orders"],
      resolution: selectedResolution("resource-orders", "orders.csv"),
    });
    const context = buildTurnContext({
      messages: [
        { role: "user", content: "Analyze the orders file." },
        { role: "assistant", content: "I found eight claims to verify." },
        { role: "user", content: "Settle the claims from our earlier analysis." },
      ],
      currentMessageContent: plan.prompt,
      maxContextChars: 120_000,
    });

    expect(plan).toEqual({
      prompt: "Settle the claims from our earlier analysis.",
      receipt: {
        mode: "resource_reference",
        attachmentCount: 1,
        resourceCount: 1,
        extractedCharsAvailable: attachment.content.length,
        inlineAttachmentChars: 0,
      },
    });
    expect(context).toEqual([
      { role: "user", content: "Analyze the orders file." },
      { role: "assistant", content: "I found eight claims to verify." },
      { role: "user", content: "Settle the claims from our earlier analysis." },
    ]);
    expect(JSON.stringify(context)).not.toContain("order_id,total");

    const client = new TwoStepClient();
    const registry = new ToolRegistry();
    registry.register({
      name: "resources__query",
      policy: "always_allow",
      description: "Query the selected conversation resource.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      handler: async () => ({ rows: [{ order_id: 1, total: 42 }] }),
    });
    for await (const _event of runAgentLoop({
      modelId: "haiku-4-5",
      messages: context,
      registry,
      context: { userId: "user-1" },
      client,
    })) {
      // Drain the two-step tool loop.
    }

    expect(client.captured).toHaveLength(2);
    for (const request of client.captured) {
      const serialized = JSON.stringify(request.messages);
      expect(serialized).toContain("I found eight claims to verify.");
      expect(serialized).not.toContain("order_id,total");
      expect(serialized).not.toContain(attachment.content);
    }
  });

  it("falls back to a framed preview when no matching resource is mounted", () => {
    const attachment = preparedAttachment("notes.txt", "Quarterly fact: 42.");
    const plan = buildConversationResourcePrompt({
      message: "Summarize this.",
      attachments: [attachment],
      resourceIds: [],
      resolution: {
        version: 1,
        status: "none",
        intent: true,
        selected: [],
        candidates: [],
        requiresCompleteFileTool: false,
      },
    });

    expect(plan.receipt).toMatchObject({
      mode: "inline_fallback",
      attachmentCount: 1,
      resourceCount: 0,
      extractedCharsAvailable: attachment.content.length,
    });
    expect(plan.receipt.inlineAttachmentChars).toBeGreaterThan(0);
    expect(plan.prompt).toContain("Quarterly fact: 42.");
    expect(plan.prompt).toContain("strictly as DATA");
  });

  it("forces a resource read for a current document even without intent keywords", () => {
    const attachment = preparedAttachment(
      "resume.pdf",
      "Rob Lindmark\nEnterprise AI product leader",
    );
    const pending = preparePendingConversationResources([attachment])[0]!;
    const resolution = resolveConversationResources({
      message: "Is this good enough?",
      resources: [pending.manifest],
      currentResourceIds: [pending.id],
    });
    const plan = buildConversationResourcePrompt({
      message: "Is this good enough?",
      attachments: [attachment],
      resourceIds: [pending.id],
      resolution,
    });

    expect(resolution).toMatchObject({
      status: "selected",
      intent: false,
      requiresCompleteFileTool: true,
      selected: [{ resourceId: pending.id, reason: "current_upload" }],
    });
    expect(plan).toMatchObject({
      prompt: "Is this good enough?",
      receipt: {
        mode: "resource_reference",
        inlineAttachmentChars: 0,
      },
    });
  });
});

class TwoStepClient implements BedrockClient {
  readonly captured: ConverseStreamParams[] = [];

  async *converseStream(
    params: ConverseStreamParams,
  ): AsyncIterable<BedrockStreamEvent> {
    this.captured.push(params);
    if (this.captured.length === 1) {
      yield {
        type: "tool-use",
        id: "resource-query",
        name: "resources__query",
        input: {},
      };
      yield { type: "stop", reason: "tool_use" };
      return;
    }
    yield { type: "text-delta", text: "Settled." };
    yield { type: "stop", reason: "end_turn" };
  }
}

function preparedAttachment(
  name: string,
  content: string,
): PreparedChatAttachment {
  return {
    name,
    mimeType: name.endsWith(".csv")
      ? "text/csv"
      : name.endsWith(".pdf")
        ? "application/pdf"
        : "text/plain",
    kind: name.endsWith(".csv")
      ? "spreadsheet"
      : name.endsWith(".pdf")
        ? "document"
        : "text",
    content,
    sizeBytes: Buffer.byteLength(content),
    storageContent: content,
    storageEncoding: "utf8",
    extractionStatus: "extracted",
  };
}

function selectedResolution(
  resourceId: string,
  filename: string,
): ConversationResourceResolution {
  return {
    version: 1,
    status: "selected",
    intent: true,
    selected: [
      {
        resourceId,
        filename,
        mimeType: "text/csv",
        kind: "spreadsheet",
        sizeBytes: 42,
        representation: "tabular_dataset",
        coverage: "full",
        reason: "current_upload",
      },
    ],
    candidates: [{ resourceId, filename, kind: "spreadsheet" }],
    requiresCompleteFileTool: true,
  };
}
