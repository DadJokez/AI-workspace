import { createServer, type IncomingHttpHeaders } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectMcpTools } from "@ai-workspace/agent";

afterEach(() => {
  vi.unstubAllGlobals();
});

function mcpRequest(method: string, params?: Record<string, unknown>) {
  return new Request("https://comparative.example/api/mcp/notion", {
    method: "POST",
    headers: {
      Authorization: "Bearer notion-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      ...(params ? { params } : {}),
    }),
  });
}

describe("Notion MCP route", () => {
  it("requires a delegated bearer token", async () => {
    const { POST } = await import("@/app/api/mcp/notion/route");

    const res = await POST(
      new Request("https://comparative.example/api/mcp/notion", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({
      error: { message: "Notion MCP requires a bearer token." },
    });
  });

  it("lists the first-party Notion tools", async () => {
    const { POST } = await import("@/app/api/mcp/notion/route");

    const res = await POST(mcpRequest("tools/list"));

    await expect(res.json()).resolves.toMatchObject({
      result: {
        tools: [
          { name: "search" },
          { name: "get_page" },
          { name: "get_block_children" },
          { name: "append_text_block" },
        ],
      },
    });
  });

  it("searches Notion with the delegated token", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({
          object: "list",
          has_more: false,
          next_cursor: null,
          results: [
            {
              object: "page",
              id: "page-1",
              url: "https://notion.so/page-1",
              created_time: "2026-06-19T12:00:00.000Z",
              last_edited_time: "2026-06-19T12:05:00.000Z",
              parent: { type: "workspace", workspace: true },
              properties: {
                Name: {
                  type: "title",
                  title: [{ plain_text: "Launch Notes" }],
                },
              },
            },
          ],
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("@/app/api/mcp/notion/route");

    const res = await POST(
      mcpRequest("tools/call", {
        name: "search",
        arguments: { query: "launch", pageSize: 1 },
      }),
    );
    const body = await res.json();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.notion.com/v1/search",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer notion-token",
          "Notion-Version": "2026-03-11",
        }),
      }),
    );
    expect(body.result.content[0].text).toContain("Launch Notes");
    expect(body.result.isError).toBeUndefined();
  });

  it("retrieves a page with an escaped page id", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        object: "page",
        id: "page/id",
        url: "https://notion.so/page-id",
        properties: {
          Name: {
            type: "title",
            title: [{ plain_text: "Escaped Page" }],
          },
          Notes: {
            type: "rich_text",
            rich_text: [{ plain_text: "Visible notes" }],
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("@/app/api/mcp/notion/route");

    const res = await POST(
      mcpRequest("tools/call", {
        name: "get_page",
        arguments: { pageId: "page/id" },
      }),
    );
    const body = await res.json();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.notion.com/v1/pages/page%2Fid",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer notion-token",
        }),
      }),
    );
    expect(body.result.content[0].text).toContain("Escaped Page");
    expect(body.result.content[0].text).toContain("Visible notes");
  });

  it("retrieves block children with escaped block ids and clamped page size", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        object: "list",
        has_more: true,
        next_cursor: "cursor-2",
        results: [
          {
            object: "block",
            id: "block-1",
            type: "paragraph",
            has_children: false,
            paragraph: {
              rich_text: [{ plain_text: "A paragraph" }],
            },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("@/app/api/mcp/notion/route");

    const res = await POST(
      mcpRequest("tools/call", {
        name: "get_block_children",
        arguments: {
          blockId: "block/id",
          pageSize: 999,
          startCursor: "cursor-1",
        },
      }),
    );
    const body = await res.json();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.notion.com/v1/blocks/block%2Fid/children?page_size=50&start_cursor=cursor-1",
      expect.any(Object),
    );
    expect(body.result.content[0].text).toContain("A paragraph");
    expect(body.result.content[0].text).toContain('"hasMore": true');
  });

  it("appends a text block with the expected PATCH body", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedInit = init;
        return Response.json({
          object: "list",
          results: [
            {
              object: "block",
              id: "new-block",
              type: "paragraph",
              has_children: false,
              paragraph: {
                rich_text: [{ plain_text: "Added paragraph" }],
              },
            },
          ],
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("@/app/api/mcp/notion/route");

    const res = await POST(
      mcpRequest("tools/call", {
        name: "append_text_block",
        arguments: {
          blockId: "parent/id",
          text: "Added paragraph",
        },
      }),
    );
    const body = await res.json();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.notion.com/v1/blocks/parent%2Fid/children",
      expect.objectContaining({ method: "PATCH" }),
    );
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              { type: "text", text: { content: "Added paragraph" } },
            ],
          },
        },
      ],
    });
    expect(body.result.content[0].text).toContain("Added paragraph");
    expect(body.result.isError).toBeUndefined();
  });

  it("rejects append_text_block inputs over the Notion rich text limit", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("@/app/api/mcp/notion/route");

    const res = await POST(
      mcpRequest("tools/call", {
        name: "append_text_block",
        arguments: {
          blockId: "parent-id",
          text: "x".repeat(2_001),
        },
      }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({
      result: {
        isError: true,
        content: [
          {
            text: "text must be 2000 characters or fewer.",
          },
        ],
      },
    });
  });

  it("connects through the existing MCP client", async () => {
    const realFetch = globalThis.fetch.bind(globalThis);
    const fetchMock = vi.fn(async () =>
      Response.json({
        object: "list",
        has_more: false,
        next_cursor: null,
        results: [
          {
            object: "page",
            id: "page-1",
            properties: {
              Name: {
                type: "title",
                title: [{ plain_text: "Client Connected" }],
              },
            },
          },
        ],
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (url.startsWith("https://api.notion.com/")) {
          return fetchMock();
        }
        return realFetch(input, init);
      }),
    );
    const { handleNotionMcpRequest } = await import("@/lib/notion/mcp");
    const server = await startRouteServer(handleNotionMcpRequest);
    try {
      const mcp = await connectMcpTools({
        notion: {
          url: server.url,
          headers: { Authorization: "Bearer notion-token" },
        },
      });
      try {
        expect(mcp.tools.map((tool) => tool.name)).toContain("notion__search");
        const search = mcp.tools.find((tool) => tool.name === "notion__search");
        await expect(search?.handler({ query: "client" }, { userId: "u1" }))
          .resolves.toMatchObject({
            value: { results: [{ title: "Client Connected" }] },
          });
      } finally {
        await mcp.close();
      }
    } finally {
      await server.close();
    }
  });

  it("returns Notion API failures as tool-visible errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { code: "restricted_resource", message: "Page is not shared." },
          { status: 403 },
        ),
      ),
    );
    const { POST } = await import("@/app/api/mcp/notion/route");

    const res = await POST(
      mcpRequest("tools/call", {
        name: "get_page",
        arguments: { pageId: "page-1" },
      }),
    );

    await expect(res.json()).resolves.toMatchObject({
      result: {
        isError: true,
        content: [
          {
            text: "Notion API 403 restricted_resource: Page is not shared.",
          },
        ],
      },
    });
  });
});

async function startRouteServer(
  handler: (req: Request) => Promise<Response>,
): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const rawBody = Buffer.concat(chunks);
    const response = await handler(
      new Request(`http://127.0.0.1${req.url ?? "/"}`, {
        method: req.method,
        headers: normalizeNodeHeaders(req.headers),
        body:
          rawBody.length > 0 && req.method !== "GET" && req.method !== "HEAD"
            ? rawBody
            : undefined,
      }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("route test server failed to bind");
  }
  return {
    url: `http://127.0.0.1:${address.port}/api/mcp/notion`,
    close: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function normalizeNodeHeaders(headers: IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") out.set(key, value);
    if (Array.isArray(value)) out.set(key, value.join(", "));
  }
  return out;
}
