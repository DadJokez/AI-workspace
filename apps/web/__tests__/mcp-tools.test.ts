import { afterEach, describe, expect, it } from "vitest";
import {
  ToolRegistry,
  connectMcpTools,
  mcpToolName,
  toAwsToolConfiguration,
} from "@ai-workspace/agent";
import {
  startTestMcpServer,
  type TestMcpServer,
} from "./helpers/mcp-test-server";

/**
 * Layer 1 of the AgentCore spike (specs/003): the Bedrock loop's MCP bridge.
 * A real Streamable-HTTP MCP server runs in-process; connectMcpTools must
 * list its tools, proxy calls, forward bearer headers, and surface MCP
 * error results as thrown errors (so the loop emits isError tool results).
 */
describe("connectMcpTools", () => {
  let server: TestMcpServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("prefixes tool names with the provider and sanitizes them", () => {
    expect(mcpToolName("github", "list_pull_requests")).toBe(
      "github__list_pull_requests",
    );
    expect(mcpToolName("my-provider", "weird.tool")).toBe(
      "my_provider__weird_tool",
    );
  });

  it("keeps Bedrock tool schemas single-wrapped for AWS", () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "github__list_pull_requests",
      description: "List pull requests",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number" },
        },
      },
      handler: async () => ({}),
    });

    const registryConfig = registry.toBedrockToolConfig();
    expect(registryConfig.tools[0]?.toolSpec.inputSchema).toMatchObject({
      json: { type: "object" },
    });

    const awsConfig = toAwsToolConfiguration(registryConfig);
    const schema = awsConfig?.tools?.[0]?.toolSpec?.inputSchema;
    expect(schema).toMatchObject({ json: { type: "object" } });
    expect(schema).not.toMatchObject({ json: { json: expect.anything() } });
  });

  it("lists remote tools and proxies calls end-to-end", async () => {
    server = await startTestMcpServer();
    const connection = await connectMcpTools({
      github: { url: server.url, headers: { Authorization: "Bearer tkn-123" } },
    });

    try {
      expect(connection.providers).toEqual({ github: 2 });
      const names = connection.tools.map((t) => t.name);
      expect(names).toContain("github__echo");
      expect(names).toContain("github__always_fails");

      const echo = connection.tools.find((t) => t.name === "github__echo")!;
      expect(echo.inputSchema).toMatchObject({ type: "object" });

      const result = await echo.handler({ value: "ping" }, { userId: "u1" });
      expect(result).toBe("echo:ping");

      // The per-user bearer token must reach the wire on every request.
      expect(server.authHeaders.length).toBeGreaterThan(0);
      expect(
        server.authHeaders.every((h) => h === "Bearer tkn-123"),
      ).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it("throws on MCP error results so the loop records isError", async () => {
    server = await startTestMcpServer();
    const connection = await connectMcpTools({
      github: { url: server.url },
    });
    try {
      const failing = connection.tools.find(
        (t) => t.name === "github__always_fails",
      )!;
      await expect(failing.handler({}, { userId: "u1" })).rejects.toThrow(
        /tool exploded/,
      );
    } finally {
      await connection.close();
    }
  });

  it("fails loudly when the server is unreachable", async () => {
    await expect(
      connectMcpTools({
        github: { url: "http://127.0.0.1:9/" },
      }),
    ).rejects.toThrow();
  });
});
