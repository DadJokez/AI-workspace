import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * Loopback Streamable-HTTP MCP server for tests. Exposes one `echo` tool and
 * records every Authorization header it sees, so tests can prove per-user
 * bearer tokens actually reach the wire.
 */
export interface TestMcpServer {
  url: string;
  authHeaders: Array<string | undefined>;
  close(): Promise<void>;
}

export async function startTestMcpServer(): Promise<TestMcpServer> {
  const mcp = new Server(
    { name: "test-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "echo",
        description: "Echoes the value back.",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
      },
      {
        name: "always_fails",
        description: "Always returns an MCP error result.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === "echo") {
      const value = String(
        (req.params.arguments as { value?: unknown })?.value ?? "",
      );
      return { content: [{ type: "text", text: `echo:${value}` }] };
    }
    return {
      content: [{ type: "text", text: "tool exploded" }],
      isError: true,
    };
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await mcp.connect(transport);

  const authHeaders: Array<string | undefined> = [];
  const httpServer: HttpServer = createServer(async (req, res) => {
    authHeaders.push(req.headers.authorization);
    let parsedBody: unknown;
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      parsedBody = raw ? JSON.parse(raw) : undefined;
    }
    await transport.handleRequest(req, res, parsedBody);
  });

  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Test MCP server failed to bind a port.");
  }

  return {
    url: `http://127.0.0.1:${address.port}/`,
    authHeaders,
    close: async () => {
      await transport.close().catch(() => {});
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
