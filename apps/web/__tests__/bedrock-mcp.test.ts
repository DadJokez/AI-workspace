import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentEvent,
  BedrockClient,
  BedrockStreamEvent,
  ConverseStreamParams,
} from "@ai-workspace/agent";
import { BedrockRuntime } from "@ai-workspace/agent-runtime";
import {
  startTestMcpServer,
  type TestMcpServer,
} from "./helpers/mcp-test-server";

/**
 * The money test for the spike: a Bedrock turn that calls an MCP tool.
 * A scripted Bedrock client asks for `github__echo`; the runtime must
 * connect the loopback MCP server, dispatch the call through the existing
 * agent loop, feed the result back, and finish the turn — proving the
 * Bedrock lane is no longer tool-less.
 */
class ScriptedBedrockClient implements BedrockClient {
  calls = 0;
  toolResultSeen: string | null = null;
  toolChoices: ConverseStreamParams["toolConfig"][] = [];

  async *converseStream(
    params: ConverseStreamParams,
  ): AsyncIterable<BedrockStreamEvent> {
    this.calls += 1;
    this.toolChoices.push(params.toolConfig);
    if (this.calls === 1) {
      yield {
        type: "tool-use",
        id: "call-1",
        name: "github__echo",
        input: { value: "ping" },
      } as BedrockStreamEvent;
      yield { type: "usage", tokensIn: 10, tokensOut: 5 } as BedrockStreamEvent;
      yield { type: "stop", reason: "tool_use" } as BedrockStreamEvent;
      return;
    }
    const lastMessage = params.messages[params.messages.length - 1];
    const resultBlock = lastMessage?.content.find(
      (b) => b.kind === "tool-result",
    );
    this.toolResultSeen =
      typeof resultBlock?.content === "string"
        ? (resultBlock.content as string)
        : null;
    yield { type: "text-delta", text: "done" } as BedrockStreamEvent;
    yield { type: "usage", tokensIn: 5, tokensOut: 2 } as BedrockStreamEvent;
    yield { type: "stop", reason: "end_turn" } as BedrockStreamEvent;
  }
}

describe("BedrockRuntime with MCP servers", () => {
  let server: TestMcpServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("mounts per-turn MCP tools and round-trips a tool call", async () => {
    server = await startTestMcpServer();
    const client = new ScriptedBedrockClient();
    const runtime = new BedrockRuntime({ client });

    const events: AgentEvent[] = [];
    for await (const ev of runtime.runTurn({
      threadId: "thread-1",
      modelId: "sonnet-4-6",
      messages: [{ role: "user", content: "run the echo tool" }],
      context: { userId: "u1" },
      requiredToolName: "github__echo",
      mcpServers: {
        github: {
          type: "http",
          url: server.url,
          headers: { Authorization: "Bearer tkn-456" },
        },
      },
    })) {
      events.push(ev);
    }

    const toolCall = events.find((e) => e.type === "tool-call");
    expect(toolCall).toMatchObject({
      call: { name: "github__echo", input: { value: "ping" } },
    });

    const toolResult = events.find((e) => e.type === "tool-result");
    expect(toolResult).toMatchObject({ result: { output: "echo:ping" } });

    // The second model call must have received the tool result — #497:
    // MCP output reaches the model nonce-framed as DATA, while the
    // tool-result event above keeps the raw text for persistence.
    expect(client.toolResultSeen).toContain("echo:ping");
    expect(client.toolResultSeen).toContain("Tool result from github__echo");
    expect(client.toolResultSeen).toMatch(
      /<<<TOOL-RESULT [0-9a-f-]{36}>>>[\s\S]*<<<END-TOOL-RESULT [0-9a-f-]{36}>>>/,
    );
    expect(client.toolChoices[0]?.toolChoice).toEqual({
      tool: { name: "github__echo" },
    });
    expect(client.toolChoices[1]?.toolChoice).toBeUndefined();
    // And the bearer header must have reached the MCP wire.
    expect(
      server.authHeaders.every((h) => h === "Bearer tkn-456"),
    ).toBe(true);

    expect(events.some((e) => e.type === "done")).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("continues tool-less with an error event when MCP connect fails", async () => {
    const client = new ScriptedBedrockClient();
    const runtime = new BedrockRuntime({ client });

    const events: AgentEvent[] = [];
    for await (const ev of runtime.runTurn({
      threadId: "thread-2",
      modelId: "sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
      context: { userId: "u1" },
      mcpServers: {
        github: { type: "http", url: "http://127.0.0.1:9/" },
      },
    })) {
      events.push(ev);
    }

    expect(
      events.some(
        (e) => e.type === "error" && e.message.includes("MCP connection failed"),
      ),
    ).toBe(true);
    // The turn still completes (model answers without tools).
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("filters mounted MCP tools to the allowed provider-native names", async () => {
    server = await startTestMcpServer();
    const client = new ScriptedBedrockClient();
    const runtime = new BedrockRuntime({ client });

    const events: AgentEvent[] = [];
    for await (const ev of runtime.runTurn({
      threadId: "thread-3",
      modelId: "sonnet-4-6",
      messages: [{ role: "user", content: "run the echo tool" }],
      context: { userId: "u1" },
      mcpServers: {
        github: {
          type: "http",
          url: server.url,
          allowedTools: ["always_fails"],
        },
      },
    })) {
      events.push(ev);
    }

    expect(events).toContainEqual({
      type: "tool-result",
      result: {
        toolCallId: "call-1",
        output: "Tool not registered: github__echo",
        isError: true,
      },
    });
  });

  it("keeps blocked MCP tools hidden even when they are also allowed", async () => {
    server = await startTestMcpServer();
    const client = new ScriptedBedrockClient();
    const runtime = new BedrockRuntime({ client });

    const events: AgentEvent[] = [];
    for await (const ev of runtime.runTurn({
      threadId: "thread-4",
      modelId: "sonnet-4-6",
      messages: [{ role: "user", content: "run the echo tool" }],
      context: { userId: "u1" },
      mcpServers: {
        github: {
          type: "http",
          url: server.url,
          allowedTools: ["echo"],
          blockedTools: ["echo"],
        },
      },
    })) {
      events.push(ev);
    }

    expect(events).toContainEqual({
      type: "tool-result",
      result: {
        toolCallId: "call-1",
        output: "Tool not registered: github__echo",
        isError: true,
      },
    });
  });
});

class EndTurnClient implements BedrockClient {
  toolConfigs: ConverseStreamParams["toolConfig"][] = [];

  async *converseStream(
    params: ConverseStreamParams,
  ): AsyncIterable<BedrockStreamEvent> {
    this.toolConfigs.push(params.toolConfig);
    yield { type: "text-delta", text: "ok" } as BedrockStreamEvent;
    yield { type: "stop", reason: "end_turn" } as BedrockStreamEvent;
  }
}

/**
 * #384 P1 parity pins: with every granted provider activated, tool
 * discovery must be byte-invisible — same schemas, same order, same turn.
 * With nothing activated, dynamic provider tools must not mount.
 */
describe("BedrockRuntime tool discovery (#384 P1)", () => {
  // Each capture gets its own loopback server — the helper serves one
  // MCP session, so reusing it times the second connection out.
  async function capturedToolConfig(
    toolDiscovery?: { activatedProviders: string[] },
  ) {
    const server = await startTestMcpServer();
    try {
      const client = new EndTurnClient();
      const runtime = new BedrockRuntime({ client });
      for await (const _ev of runtime.runTurn({
        threadId: "thread-discovery",
        modelId: "sonnet-4-6",
        messages: [{ role: "user", content: "hello" }],
        context: { userId: "u1" },
        mcpServers: {
          github: { type: "http", url: server.url },
        },
        ...(toolDiscovery ? { toolDiscovery } : {}),
      })) {
        // drain
      }
      return client.toolConfigs[0];
    } finally {
      await server.close();
    }
  }

  it("is byte-identical to today under full activation", async () => {
    const without = await capturedToolConfig();
    const withAll = await capturedToolConfig({
      activatedProviders: ["github"],
    });
    expect(JSON.stringify(withAll)).toBe(JSON.stringify(without));
    expect(withAll?.tools.map((t) => t.toolSpec.name)).toContain(
      "github__echo",
    );
  });

  it("mounts no provider tools when nothing is activated", async () => {
    const config = await capturedToolConfig({ activatedProviders: [] });
    expect(config).toBeUndefined();
  });
});
