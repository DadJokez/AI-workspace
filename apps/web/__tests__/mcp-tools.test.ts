import { afterEach, describe, expect, it } from "vitest";
import {
  ToolRegistry,
  connectMcpTools,
  mcpToolName,
  normalizeToolInputSchema,
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

  it("normalizes missing or non-object tool schemas for AWS", () => {
    expect(normalizeToolInputSchema({ properties: { q: { type: "string" } } }))
      .toEqual({
        type: "object",
        properties: { q: { type: "string" } },
      });
    expect(normalizeToolInputSchema({ type: "string" })).toEqual({
      type: "object",
      properties: {},
    });
    expect(normalizeToolInputSchema(null)).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("lists remote tools and proxies calls end-to-end", async () => {
    server = await startTestMcpServer();
    const connection = await connectMcpTools({
      github: { url: server.url, headers: { Authorization: "Bearer tkn-123" } },
    });

    try {
      expect(connection.providers).toEqual({ github: 2 });
      const names = connection.tools.map((t) => t.name);
      expect(names).toEqual([
        "github__always_fails",
        "github__echo",
      ]);

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

  it("keeps provider and tool registration deterministic", async () => {
    server = await startTestMcpServer();
    const secondServer = await startTestMcpServer();
    const connection = await connectMcpTools({
      zeta: { url: server.url },
      alpha: { url: secondServer.url },
    });
    try {
      expect(Object.keys(connection.providers)).toEqual(["alpha", "zeta"]);
      expect(connection.tools.map((tool) => tool.name)).toEqual([
        "alpha__always_fails",
        "alpha__echo",
        "zeta__always_fails",
        "zeta__echo",
      ]);
    } finally {
      await connection.close();
      await secondServer.close();
    }
  });

  it("#713: reports an unreachable server as a failed provider instead of throwing", async () => {
    const connection = await connectMcpTools({
      github: { url: "http://127.0.0.1:9/" },
    });
    try {
      expect(connection.tools).toEqual([]);
      expect(connection.providers).toEqual({});
      expect(connection.failedProviders).toHaveLength(1);
      expect(connection.failedProviders[0]).toMatchObject({
        provider: "github",
        displayName: "github",
      });
    } finally {
      await connection.close();
    }
  });

  it("#713: mounts the reachable server's tools when another server is dead", async () => {
    server = await startTestMcpServer();
    const connection = await connectMcpTools({
      github: { url: server.url },
      salesforce: { url: "http://127.0.0.1:9/", displayName: "Salesforce" },
    });
    try {
      expect(connection.tools.map((tool) => tool.name)).toEqual([
        "github__always_fails",
        "github__echo",
      ]);
      expect(connection.providers).toEqual({ github: 2 });
      expect(connection.failedProviders).toHaveLength(1);
      expect(connection.failedProviders[0]).toMatchObject({
        provider: "salesforce",
        displayName: "Salesforce",
      });
    } finally {
      await connection.close();
    }
  });
});
