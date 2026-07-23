import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@ai-workspace/db";

import {
  buildConversationResourceTurnContext,
  RESOURCE_MCP_CONTEXT_HEADER,
  RESOURCE_MCP_RELAY_HEADER,
  resourceMcpRelayToken,
  signConversationResourceTurnContext,
  verifyConversationResourceTurnContext,
} from "@/lib/conversation-resource-authorization";
import type { ConversationResourceResolution } from "@/lib/conversation-resources";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NEXTAUTH_URL", "https://comparative.example");
  vi.stubEnv("OAUTH_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("conversation resource MCP authorization (#576)", () => {
  it("signs only the selected user/thread/run resource ids", () => {
    const context = buildConversationResourceTurnContext({
      userId: "user-1",
      threadId: "thread-1",
      runId: "run-1",
      resolution: selectedResolution(),
      now: new Date("2026-07-22T12:00:00.000Z"),
    });
    const signed = signConversationResourceTurnContext(context);

    expect(
      verifyConversationResourceTurnContext(
        signed,
        new Date("2026-07-22T12:30:00.000Z"),
      ),
    ).toEqual(context);
    expect(
      verifyConversationResourceTurnContext(
        signed,
        new Date("2026-07-22T14:01:00.000Z"),
      ),
    ).toBeNull();
  });

  it("requires both the internal relay and signed turn context", async () => {
    const { handleConversationResourceMcpRequest } = await import(
      "@/lib/conversation-resource-mcp"
    );
    const response = await handleConversationResourceMcpRequest(
      new Request("https://comparative.example/api/mcp/resources", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
        }),
      }),
    );
    expect(response.status).toBe(403);
  });

  it("lists one bounded complete-file query tool without touching the database", async () => {
    const { handleConversationResourceMcpRequest } = await import(
      "@/lib/conversation-resource-mcp"
    );
    const context = buildConversationResourceTurnContext({
      userId: "user-1",
      threadId: "thread-1",
      runId: "run-1",
      resolution: selectedResolution(),
    });
    const response = await handleConversationResourceMcpRequest(
      new Request("https://comparative.example/api/mcp/resources", {
        method: "POST",
        headers: {
          [RESOURCE_MCP_RELAY_HEADER]: resourceMcpRelayToken(),
          [RESOURCE_MCP_CONTEXT_HEADER]:
            signConversationResourceTurnContext(context),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
        }),
      }),
    );
    const json = (await response.json()) as {
      result: {
        tools: Array<{
          name: string;
          description: string;
          inputSchema: {
            properties: Record<
              string,
              { description?: string; type?: string | string[] }
            >;
          };
        }>;
      };
    };

    expect(response.status).toBe(200);
    expect(json.result.tools).toHaveLength(1);
    expect(json.result.tools[0]).toMatchObject({
      name: "query",
      inputSchema: {
        required: ["resourceId", "operation"],
        additionalProperties: false,
      },
    });
    expect(json.result.tools[0]?.description).toContain(
      "Filtered aggregates are not supported",
    );
    expect(
      json.result.tools[0]?.inputSchema.properties.filterColumn?.description,
    ).toContain("operation=table_filter");
    expect(
      json.result.tools[0]?.inputSchema.properties.filterValue?.type,
    ).toEqual(["string", "number", "boolean"]);
  });

  it("rejects a resource id that was not selected for this user/thread/run", async () => {
    const { handleConversationResourceMcpRequest } = await import(
      "@/lib/conversation-resource-mcp"
    );
    const context = buildConversationResourceTurnContext({
      userId: "user-1",
      threadId: "thread-1",
      runId: "run-1",
      resolution: selectedResolution(),
    });
    const response = await handleConversationResourceMcpRequest(
      new Request("https://comparative.example/api/mcp/resources", {
        method: "POST",
        headers: {
          [RESOURCE_MCP_RELAY_HEADER]: resourceMcpRelayToken(),
          [RESOURCE_MCP_CONTEXT_HEADER]:
            signConversationResourceTurnContext(context),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "query",
            arguments: {
              resourceId: "resource-from-another-thread",
              operation: "read",
            },
          },
        }),
      }),
    );
    const json = (await response.json()) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };

    expect(response.status).toBe(200);
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0]?.text).toContain("not authorized");
  });

  it("builds an AgentCore-compatible HTTP mount and forces the query tool for complete analysis", async () => {
    const {
      buildConversationResourceMcpServer,
      CONVERSATION_RESOURCE_QUERY_TOOL,
    } = await import("@/lib/conversation-resource-runtime");
    const server = buildConversationResourceMcpServer({
      userId: "user-1",
      threadId: "thread-1",
      runId: "run-1",
      resolution: selectedResolution(),
    });

    expect(server).toMatchObject({
      type: "http",
      url: "https://comparative.example/api/mcp/resources",
      allowedTools: ["query"],
      headers: {
        [RESOURCE_MCP_RELAY_HEADER]: expect.any(String),
        [RESOURCE_MCP_CONTEXT_HEADER]: expect.stringMatching(/\./),
      },
    });
    expect(CONVERSATION_RESOURCE_QUERY_TOOL).toBe("resources__query");
  });

  it("restores selected image bytes as native visual input on later turns", async () => {
    const { loadSelectedResourceImages } = await import(
      "@/lib/conversation-resource-runtime"
    );
    const db = {
      select: () => ({
        from: () => ({
          where: async () => [
            {
              id: "resource-image",
              filename: "screen.png",
              mimeType: "image/png",
              content: Buffer.from("native-image-bytes").toString("base64"),
              sizeBytes: 18,
              metadata: {
                storageEncoding: "base64",
                image: { width: 640, height: 480 },
              },
            },
          ],
        }),
      }),
    } as unknown as Database;
    const resolution: ConversationResourceResolution = {
      version: 1,
      status: "selected",
      intent: true,
      selected: [
        {
          resourceId: "resource-image",
          filename: "screen.png",
          mimeType: "image/png",
          kind: "image",
          sizeBytes: 18,
          representation: "native_image",
          coverage: "full",
          reason: "previous_run_receipt",
        },
      ],
      candidates: [
        {
          resourceId: "resource-image",
          filename: "screen.png",
          kind: "image",
        },
      ],
      requiresCompleteFileTool: false,
    };

    const files = await loadSelectedResourceImages({
      db,
      userId: "user-1",
      threadId: "thread-1",
      resolution,
    });

    expect(files).toEqual([
      expect.objectContaining({
        resourceId: "resource-image",
        name: "screen.png",
        extractionStatus: "native_image",
        runtimeContent: {
          type: "image",
          mimeType: "image/png",
          dataBase64: Buffer.from("native-image-bytes").toString("base64"),
        },
      }),
    ]);
  });
});

function selectedResolution(): ConversationResourceResolution {
  return {
    version: 1,
    status: "selected",
    intent: true,
    selected: [
      {
        resourceId: "resource-1",
        filename: "report.csv",
        mimeType: "text/csv",
        kind: "spreadsheet",
        sizeBytes: 1024,
        representation: "tabular_dataset",
        coverage: "full",
        reason: "sole_thread_resource",
      },
    ],
    candidates: [
      {
        resourceId: "resource-1",
        filename: "report.csv",
        kind: "spreadsheet",
      },
    ],
    requiresCompleteFileTool: true,
  };
}
