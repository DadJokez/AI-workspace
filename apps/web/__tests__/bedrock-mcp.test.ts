import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentEvent,
  BedrockClient,
  BedrockStreamEvent,
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

  async *converseStream(params: {
    messages: Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
  }): AsyncIterable<BedrockStreamEvent> {
    this.calls += 1;
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

    // The second model call must have received the tool result.
    expect(client.toolResultSeen).toBe("echo:ping");
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
});
