import { readFileSync } from "node:fs";
import path from "node:path";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDiscoveryTools,
  type DiscoveryCatalogEntry,
} from "@ai-workspace/agent";
import type { Database } from "@ai-workspace/db";
import {
  buildTurnToolDiscovery,
  detectRequestedProviders,
} from "@/lib/tool-discovery";

/**
 * Notion tools_catalog seed (#712).
 *
 * Progressive tool discovery selects candidate providers from the catalog,
 * so a provider with no seeded rows is unreachable except through the
 * provider-name fast path — a connected Notion behaved as absent unless the
 * user literally typed "notion". These tests pin the seed itself:
 *
 *   1. it covers exactly the tools the first-party Notion MCP route serves
 *      (the catalog must never advertise a tool that does not exist), and
 *   2. its descriptions let a Notion-shaped request rank a Notion tool
 *      first in `comparative__search_tools` without naming the provider.
 *
 * The catalog fixture is parsed from the real handwritten migrations (the
 * production source of truth), so description drift breaks this test
 * instead of silently breaking selection.
 */

const DRIZZLE_DIR = path.resolve(__dirname, "../../../packages/db/drizzle");
const CATALOG_SEED_MIGRATIONS = [
  "0028_github_tools_catalog_seed.sql",
  "0032_google_tools_catalog.sql",
  "0035_salesforce_tools_catalog.sql",
  "0040_notion_tools_catalog.sql",
] as const;

/**
 * One seed_tools VALUES row: (tool, display, description, category,
 * action::"tool_catalog_action"[, requires_attestation]). Only the seed rows
 * carry the enum cast, so the mcp_servers upsert can never false-match.
 */
const SEED_ROW_RE =
  /^\s*\('([^']+)',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*'([^']+)',\s*'(read|write|admin)'::"tool_catalog_action"(?:,\s*(?:true|false))?\),?$/;

function parseSeedCatalog(fileName: string): DiscoveryCatalogEntry[] {
  const provider = fileName.split("_")[1]!;
  const sql = readFileSync(path.join(DRIZZLE_DIR, fileName), "utf8");
  const entries = sql
    .split("\n")
    .map((line) => SEED_ROW_RE.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      provider,
      tool: match[1]!,
      displayName: unescapeSql(match[2]!),
      description: unescapeSql(match[3]!),
      category: match[4]!,
      action: match[5] as DiscoveryCatalogEntry["action"],
    }));
  if (entries.length === 0) {
    throw new Error(`No seed rows parsed from ${fileName} — format changed?`);
  }
  return entries;
}

function unescapeSql(value: string): string {
  return value.replaceAll("''", "'");
}

const SEEDED_CATALOG = CATALOG_SEED_MIGRATIONS.flatMap(parseSeedCatalog);
const NOTION_SEED = SEEDED_CATALOG.filter(
  (entry) => entry.provider === "notion",
);

/** A Notion-shaped request that never names the provider. */
const NOTION_SHAPED_MESSAGE = "what's in my meeting notes?";

const TEST_OAUTH_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString("base64");
const RELAY_HMAC_MESSAGE = "comparative:notion-mcp-relay:v1";

describe("notion catalog seed ↔ first-party MCP parity", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NEXTAUTH_URL", "https://comparative.example");
    vi.stubEnv("OAUTH_ENCRYPTION_KEY", TEST_OAUTH_ENCRYPTION_KEY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("seeds exactly the tools the Notion MCP route serves, in order", async () => {
    const { POST } = await import("@/app/api/mcp/notion/route");
    const res = await POST(
      new Request("https://comparative.example/api/mcp/notion", {
        method: "POST",
        headers: {
          Authorization: "Bearer notion-token",
          "Content-Type": "application/json",
          "X-Comparative-MCP-Relay": createHmac(
            "sha256",
            TEST_OAUTH_ENCRYPTION_KEY,
          )
            .update(RELAY_HMAC_MESSAGE)
            .digest("hex"),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    const json = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    const served = json.result.tools.map((tool) => tool.name);
    expect(NOTION_SEED.map((entry) => entry.tool)).toEqual(served);
  });
});

describe("notion selection from the seeded catalog (#712)", () => {
  it("the message does not trigger the provider-name fast path", () => {
    expect(
      detectRequestedProviders(NOTION_SHAPED_MESSAGE, [
        "github",
        "google",
        "notion",
        "salesforce",
      ]),
    ).toEqual([]);
  });

  it("comparative__search_tools ranks a Notion tool first for a Notion-shaped task", async () => {
    const [search] = createDiscoveryTools({
      catalog: SEEDED_CATALOG,
      activatedProviders: new Set(),
    });
    const output = (await search!.handler(
      { query: NOTION_SHAPED_MESSAGE },
      { userId: "u1" },
    )) as { results: Array<{ provider: string; tool: string }> };

    expect(output.results[0]).toMatchObject({
      provider: "notion",
      tool: "get_page_markdown",
    });
  });

  it("a granted Notion becomes discoverable for that message (no fast path needed)", async () => {
    const rows = NOTION_SEED.map((entry) => ({
      provider: entry.provider,
      toolName: entry.tool,
      displayName: entry.displayName ?? null,
      description: entry.description,
      category: entry.category,
      action: entry.action,
      enabled: true,
    }));
    const set = vi
      .fn()
      .mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
    const db = {
      update: vi.fn().mockReturnValue({ set }),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(rows),
        }),
      }),
    } as unknown as Database;

    const result = await buildTurnToolDiscovery({
      db,
      thread: { id: "t1", mcpSignature: null },
      grantedProviders: ["notion"],
      userMessage: NOTION_SHAPED_MESSAGE,
    });

    // Not named, not core — notion must not pre-mount…
    expect(result.activatedProviders).not.toContain("notion");
    // …but with the seed in place it IS advertised and activatable.
    expect(result.discoverableProviders).toEqual(["notion"]);
    expect(
      result.catalog?.filter((entry) => entry.provider === "notion"),
    ).toHaveLength(NOTION_SEED.length);
  });
});
