import { NOTION_API_VERSION } from "@/lib/oauth/notion";
import { PUBLIC_BASE_URL } from "@/lib/oauth/github";

export const NOTION_MCP_PATH = "/api/mcp/notion";

const NOTION_API_BASE = "https://api.notion.com/v1";
const MCP_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_MCP_PROTOCOL_VERSIONS = new Set([
  MCP_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
]);
const MAX_RESULT_CHARS = 28_000;
const MAX_APPEND_TEXT_CHARS = 2_000;

type JsonRpcId = string | number | null;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
}

interface NotionToolContext {
  accessToken: string;
}

export async function handleNotionMcpRequest(req: Request): Promise<Response> {
  if (req.method === "GET" || req.method === "DELETE") {
    return new Response(null, { status: 405 });
  }
  if (req.method !== "POST") {
    return jsonRpcError(null, -32000, "Method not allowed.", { status: 405 });
  }

  const sameOriginError = validateSameOrigin(req);
  if (sameOriginError) return sameOriginError;

  const accessToken = bearerToken(req);
  if (!accessToken) {
    return jsonRpcError(null, -32001, "Notion MCP requires a bearer token.", {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="notion-mcp"' },
    });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonRpcError(null, -32700, "Invalid JSON request body.", {
      status: 400,
    });
  }

  const batch = Array.isArray(body);
  const messages: unknown[] = batch ? (body as unknown[]) : [body];
  const responses = [];
  for (const message of messages) {
    const response = await handleJsonRpcMessage(message, { accessToken });
    if (response) responses.push(response);
  }

  if (responses.length === 0) {
    return new Response(null, { status: 202 });
  }
  return Response.json(batch ? responses : responses[0]);
}

function validateSameOrigin(req: Request): Response | null {
  const expected = new URL(PUBLIC_BASE_URL);
  const requestUrl = new URL(req.url);
  const host = (
    req.headers.get("x-forwarded-host") ??
    req.headers.get("host") ??
    requestUrl.host
  ).toLowerCase();
  if (host !== expected.host.toLowerCase()) {
    return jsonRpcError(null, -32000, "Notion MCP host is not allowed.", {
      status: 403,
    });
  }

  const origin = req.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).origin !== expected.origin) {
        return jsonRpcError(
          null,
          -32000,
          "Notion MCP origin is not allowed.",
          { status: 403 },
        );
      }
    } catch {
      return jsonRpcError(null, -32000, "Notion MCP origin is invalid.", {
        status: 403,
      });
    }
  }

  return null;
}

async function handleJsonRpcMessage(
  value: unknown,
  ctx: NotionToolContext,
): Promise<Record<string, unknown> | null> {
  if (!isRecord(value) || value.jsonrpc !== "2.0") {
    return jsonRpcErrorBody(null, -32600, "Invalid JSON-RPC request.");
  }
  const message = value as JsonRpcMessage;
  const id = Object.prototype.hasOwnProperty.call(message, "id")
    ? (message.id ?? null)
    : null;
  const isNotification = !Object.prototype.hasOwnProperty.call(message, "id");
  if (typeof message.method !== "string") {
    if (isNotification) return null;
    return jsonRpcErrorBody(id, -32600, "JSON-RPC method is required.");
  }

  try {
    switch (message.method) {
      case "initialize":
        return isNotification
          ? null
          : jsonRpcResult(id, initializeResult(message.params));
      case "notifications/initialized":
        return null;
      case "tools/list":
        return isNotification ? null : jsonRpcResult(id, { tools: notionTools });
      case "tools/call":
        return isNotification
          ? null
          : jsonRpcResult(id, await callNotionTool(message.params, ctx));
      default:
        return isNotification
          ? null
          : jsonRpcErrorBody(id, -32601, `Unknown MCP method: ${message.method}`);
    }
  } catch (err) {
    return jsonRpcResult(id, {
      content: [{ type: "text", text: notionErrorText(err) }],
      isError: true,
    });
  }
}

function initializeResult(params: unknown) {
  const requested = isRecord(params) ? params.protocolVersion : null;
  const protocolVersion =
    typeof requested === "string" &&
    SUPPORTED_MCP_PROTOCOL_VERSIONS.has(requested)
      ? requested
      : MCP_PROTOCOL_VERSION;
  return {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: "comparative-notion", version: "1.0.0" },
    instructions:
      "Use these tools only for Notion content shared with the connected Comparative integration.",
  };
}

const notionTools = [
  {
    name: "search",
    description:
      "Search Notion pages and databases shared with the connected Comparative integration.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "Optional search text for page or database titles.",
        },
        object: {
          type: "string",
          enum: ["page", "database"],
          description: "Optional object type filter.",
        },
        pageSize: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "Maximum results to return.",
        },
        startCursor: {
          type: "string",
          description: "Optional pagination cursor from a previous search.",
        },
      },
    },
  },
  {
    name: "get_page",
    description:
      "Retrieve metadata and visible properties for a Notion page shared with the integration.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["pageId"],
      properties: {
        pageId: {
          type: "string",
          description: "The Notion page id.",
        },
      },
    },
  },
  {
    name: "get_block_children",
    description:
      "Read child blocks for a Notion page or block shared with the integration.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["blockId"],
      properties: {
        blockId: {
          type: "string",
          description: "The Notion page or block id.",
        },
        pageSize: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Maximum child blocks to return.",
        },
        startCursor: {
          type: "string",
          description: "Optional pagination cursor from a previous read.",
        },
      },
    },
  },
  {
    name: "append_text_block",
    description:
      "Append a plain text paragraph block to a Notion page or block shared with write access.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["blockId", "text"],
      properties: {
        blockId: {
          type: "string",
          description: "The Notion page or block id to append under.",
        },
        text: {
          type: "string",
          maxLength: MAX_APPEND_TEXT_CHARS,
          description: "Plain text to append as a paragraph.",
        },
      },
    },
  },
] as const;

async function callNotionTool(params: unknown, ctx: NotionToolContext) {
  if (!isRecord(params) || typeof params.name !== "string") {
    throw new Error("tools/call requires a tool name.");
  }
  const args = isRecord(params.arguments) ? params.arguments : {};
  switch (params.name) {
    case "search":
      return mcpTextResult(await searchNotion(args, ctx));
    case "get_page":
      return mcpTextResult(await getPage(args, ctx));
    case "get_block_children":
      return mcpTextResult(await getBlockChildren(args, ctx));
    case "append_text_block":
      return mcpTextResult(await appendTextBlock(args, ctx));
    default:
      throw new Error(`Unknown Notion tool: ${params.name}`);
  }
}

async function searchNotion(
  args: Record<string, unknown>,
  ctx: NotionToolContext,
) {
  const body: Record<string, unknown> = {
    page_size: clampInt(args.pageSize, 5, 1, 10),
  };
  const query = optionalString(args.query);
  if (query) body.query = query;
  const startCursor = optionalString(args.startCursor);
  if (startCursor) body.start_cursor = startCursor;
  const objectFilter = optionalString(args.object);
  if (objectFilter === "page" || objectFilter === "database") {
    body.filter = { property: "object", value: objectFilter };
  }

  const json = await notionFetch(ctx, "/search", {
    method: "POST",
    body: JSON.stringify(body),
  });
  const result = asRecord(json);
  return {
    object: result.object,
    hasMore: result.has_more,
    nextCursor: result.next_cursor ?? null,
    results: arrayOfRecords(result.results).map(summarizeNotionObject),
  };
}

async function getPage(
  args: Record<string, unknown>,
  ctx: NotionToolContext,
) {
  const pageId = requiredString(args.pageId, "pageId");
  const page = asRecord(
    await notionFetch(ctx, `/pages/${encodeURIComponent(pageId)}`),
  );
  return summarizePage(page);
}

async function getBlockChildren(
  args: Record<string, unknown>,
  ctx: NotionToolContext,
) {
  const blockId = requiredString(args.blockId, "blockId");
  const params = new URLSearchParams({
    page_size: String(clampInt(args.pageSize, 20, 1, 50)),
  });
  const startCursor = optionalString(args.startCursor);
  if (startCursor) params.set("start_cursor", startCursor);
  const json = asRecord(
    await notionFetch(
      ctx,
      `/blocks/${encodeURIComponent(blockId)}/children?${params}`,
    ),
  );
  return {
    object: json.object,
    hasMore: json.has_more,
    nextCursor: json.next_cursor ?? null,
    blocks: arrayOfRecords(json.results).map(summarizeBlock),
  };
}

async function appendTextBlock(
  args: Record<string, unknown>,
  ctx: NotionToolContext,
) {
  const blockId = requiredString(args.blockId, "blockId");
  const text = requiredString(args.text, "text");
  if (text.length > MAX_APPEND_TEXT_CHARS) {
    throw new Error(
      `text must be ${MAX_APPEND_TEXT_CHARS} characters or fewer.`,
    );
  }
  const json = asRecord(
    await notionFetch(ctx, `/blocks/${encodeURIComponent(blockId)}/children`, {
      method: "PATCH",
      body: JSON.stringify({
        children: [
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [{ type: "text", text: { content: text } }],
            },
          },
        ],
      }),
    }),
  );
  return {
    object: json.object,
    blockId,
    appended: arrayOfRecords(json.results).map(summarizeBlock),
  };
}

async function notionFetch(
  ctx: NotionToolContext,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const res = await fetch(`${NOTION_API_BASE}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${ctx.accessToken}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_API_VERSION,
      ...init.headers,
    },
  });
  const text = await res.text();
  const json = text ? safeJson(text) : null;
  if (!res.ok) {
    const body = isRecord(json) ? json : {};
    const code = typeof body.code === "string" ? ` ${body.code}` : "";
    const message =
      typeof body.message === "string" ? body.message : res.statusText;
    throw new Error(`Notion API ${res.status}${code}: ${message}`);
  }
  return json;
}

function mcpTextResult(value: unknown) {
  const text = truncate(JSON.stringify(value, null, 2), MAX_RESULT_CHARS);
  return { content: [{ type: "text", text }], structuredContent: { value } };
}

function summarizeNotionObject(value: Record<string, unknown>) {
  return {
    object: value.object,
    id: value.id,
    title: titleFromObject(value),
    url: value.url ?? null,
    createdTime: value.created_time ?? null,
    lastEditedTime: value.last_edited_time ?? null,
    parent: simplifyParent(value.parent),
  };
}

function summarizePage(value: Record<string, unknown>) {
  return {
    ...summarizeNotionObject(value),
    properties: summarizeProperties(value.properties),
  };
}

function summarizeBlock(value: Record<string, unknown>) {
  const type = typeof value.type === "string" ? value.type : "unknown";
  const typed = isRecord(value[type]) ? value[type] : {};
  return {
    object: value.object,
    id: value.id,
    type,
    hasChildren: value.has_children ?? false,
    text: blockText(type, typed),
  };
}

function summarizeProperties(value: unknown) {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([name, raw]) => [
      name,
      summarizeProperty(asRecord(raw)),
    ]),
  );
}

function summarizeProperty(prop: Record<string, unknown>) {
  const type = typeof prop.type === "string" ? prop.type : "unknown";
  const value = prop[type];
  switch (type) {
    case "title":
    case "rich_text":
      return richTextPlain(value);
    case "select":
    case "status":
      return isRecord(value) ? value.name ?? null : null;
    case "multi_select":
      return Array.isArray(value)
        ? value.map((item) => (isRecord(item) ? item.name : null)).filter(Boolean)
        : [];
    case "date":
      return isRecord(value) ? value : null;
    case "checkbox":
    case "number":
    case "url":
    case "email":
    case "phone_number":
      return value ?? null;
    case "people":
      return Array.isArray(value)
        ? value.map((item) => (isRecord(item) ? item.name ?? item.id : null))
        : [];
    default:
      return value ?? null;
  }
}

function titleFromObject(value: Record<string, unknown>): string {
  if (Array.isArray(value.title)) return richTextPlain(value.title);
  const props = isRecord(value.properties) ? value.properties : {};
  for (const prop of Object.values(props)) {
    if (isRecord(prop) && prop.type === "title") {
      const title = richTextPlain(prop.title);
      if (title) return title;
    }
  }
  return "Untitled";
}

function blockText(type: string, value: Record<string, unknown>): string {
  if ("rich_text" in value) return richTextPlain(value.rich_text);
  if (type === "child_page" && typeof value.title === "string") {
    return value.title;
  }
  if (type === "to_do") {
    const checked = value.checked === true ? "[x]" : "[ ]";
    return `${checked} ${richTextPlain(value.rich_text)}`.trim();
  }
  return "";
}

function richTextPlain(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      if (!isRecord(item)) return "";
      if (typeof item.plain_text === "string") return item.plain_text;
      const text = isRecord(item.text) ? item.text : {};
      return typeof text.content === "string" ? text.content : "";
    })
    .join("");
}

function simplifyParent(value: unknown) {
  if (!isRecord(value)) return null;
  const type = typeof value.type === "string" ? value.type : null;
  if (!type) return null;
  return { type, id: value[type] ?? null };
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || null;
}

function jsonRpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  init?: ResponseInit,
) {
  return Response.json(jsonRpcErrorBody(id, code, message), init);
}

function jsonRpcErrorBody(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function clampInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...truncated`;
}

function notionErrorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
