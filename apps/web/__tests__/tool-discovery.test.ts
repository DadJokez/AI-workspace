import { describe, expect, it, vi } from "vitest";
import type { Database } from "@ai-workspace/db";
import {
  buildTurnToolDiscovery,
  CORE_MCP_PROVIDERS,
  detectRequestedProviders,
  loadDiscoveryCatalog,
} from "@/lib/tool-discovery";

function mockDb(catalogRows: unknown[] = []) {
  const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
  const update = vi.fn().mockReturnValue({ set });
  const select = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(catalogRows),
    }),
  });
  return { db: { update, select } as unknown as Database, update, set };
}

const catalogRows = [
  {
    provider: "github",
    toolName: "list_pull_requests",
    displayName: "List pull requests",
    description: "List PRs in a repo.",
    category: "repos",
    action: "read",
    enabled: true,
  },
  {
    provider: "github",
    toolName: "dangerous_disabled",
    displayName: null,
    description: "Disabled row.",
    category: "repos",
    action: "admin",
    enabled: false,
  },
  {
    provider: "google",
    toolName: "search_email",
    displayName: null,
    description: null,
    category: "mail",
    action: "read",
    enabled: true,
  },
];

describe("buildTurnToolDiscovery", () => {
  it("starts new conversations at granted ∩ core plus the catalog", async () => {
    const { db } = mockDb(catalogRows);
    const result = await buildTurnToolDiscovery({
      db,
      thread: { id: "t1", mcpSignature: null },
      grantedProviders: ["github", "google", "salesforce"],
    });
    // github (heavy) stays discoverable; the light core mounts.
    expect(result.activatedProviders).toEqual(["google", "salesforce"]);
    // google is core (activated), so only github is advertised as
    // discoverable — and only because it has an enabled catalog row.
    expect(result.discoverableProviders).toEqual(["github"]);
    expect(result.catalog?.map((entry) => `${entry.provider}__${entry.tool}`)).toEqual(
      ["github__list_pull_requests", "google__search_email"],
    );
  });

  it("never advertises a non-core granted provider whose catalog is empty or all-disabled", async () => {
    // notion is granted and non-core but every row is disabled — the
    // activate tool would refuse it, so the preamble must not promise it
    // (honesty spine). github has an enabled row and stays advertised.
    const { db } = mockDb([
      ...catalogRows,
      {
        provider: "notion",
        toolName: "search",
        displayName: null,
        description: "Disabled everywhere.",
        category: "docs",
        action: "read",
        enabled: false,
      },
    ]);
    const result = await buildTurnToolDiscovery({
      db,
      thread: { id: "t1", mcpSignature: null },
      grantedProviders: ["github", "notion"],
    });
    expect(result.discoverableProviders).toEqual(["github"]);
    expect(
      result.catalog?.some((entry) => entry.provider === "notion"),
    ).toBe(false);
    // notion is non-core and has no enabled row → not activated either.
    expect(result.activatedProviders).not.toContain("notion");
  });

  it("keeps prior activations sticky and drops revoked grants", async () => {
    const { db } = mockDb(catalogRows);
    const result = await buildTurnToolDiscovery({
      db,
      thread: { id: "t1", mcpSignature: "github,notion" },
      grantedProviders: ["github", "google"],
    });
    // github persists (sticky); notion is no longer granted so it neither
    // mounts nor resurfaces; core google joins.
    expect(result.activatedProviders).toEqual(["github", "google"]);
  });

  it("core membership is the documented constant", () => {
    expect([...CORE_MCP_PROVIDERS]).toEqual(["google", "salesforce"]);
  });

  it("fast-path pre-activates a provider named in the message (#384 P3)", async () => {
    const { db } = mockDb(catalogRows);
    const result = await buildTurnToolDiscovery({
      db,
      thread: { id: "t1", mcpSignature: null },
      grantedProviders: ["github", "google", "salesforce"],
      userMessage: "can you check my GitHub PRs?",
    });
    // github would normally stay discoverable; naming it mounts it this
    // turn, so the cold request answers without a discovery round-trip.
    expect(result.activatedProviders).toEqual([
      "github",
      "google",
      "salesforce",
    ]);
    expect(result.discoverableProviders).toEqual([]);
  });

  it("fast-path never pre-activates an ungranted provider (#384 P3)", async () => {
    const { db } = mockDb([]);
    const result = await buildTurnToolDiscovery({
      db,
      thread: { id: "t1", mcpSignature: null },
      grantedProviders: ["google"],
      userMessage: "check my GitHub and Notion",
    });
    // github/notion are named but not granted — only granted core mounts.
    expect(result.activatedProviders).toEqual(["google"]);
  });

  it("an activated skill mounts exactly its declared bundle, not core (#384 P3)", async () => {
    const { db } = mockDb(catalogRows);
    const result = await buildTurnToolDiscovery({
      db,
      thread: { id: "t1", mcpSignature: null },
      grantedProviders: ["github", "google", "salesforce"],
      skillProviders: ["github"],
    });
    // The skill declares github; core google/salesforce do NOT auto-mount.
    expect(result.activatedProviders).toEqual(["github"]);
  });

  it("fast-path still adds to a skill bundle when the user names a provider (#384 P3)", async () => {
    const { db } = mockDb(catalogRows);
    const result = await buildTurnToolDiscovery({
      db,
      thread: { id: "t1", mcpSignature: null },
      grantedProviders: ["github", "google", "salesforce"],
      skillProviders: ["salesforce"],
      userMessage: "cross-reference with GitHub",
    });
    expect(result.activatedProviders).toEqual(["github", "salesforce"]);
  });
});

describe("detectRequestedProviders", () => {
  it("matches distinctive provider proper nouns, granted-only, case-insensitive", () => {
    expect(
      detectRequestedProviders("Check my GITHUB issues", [
        "github",
        "google",
      ]),
    ).toEqual(["github"]);
    expect(
      detectRequestedProviders("pull gmail and salesforce", [
        "google",
        "salesforce",
        "github",
      ]),
    ).toEqual(["google", "salesforce"]);
  });

  it("ignores generic words and substrings (high precision)", () => {
    // "calendar"/"mail"/"docs" are deliberately not aliases; substrings
    // like githubusercontent must not word-boundary match.
    expect(
      detectRequestedProviders("check my calendar and docs", [
        "google",
        "notion",
      ]),
    ).toEqual([]);
    expect(
      detectRequestedProviders("raw.githubusercontent.com/foo", ["github"]),
    ).toEqual([]);
  });

  it("returns empty for an empty message", () => {
    expect(detectRequestedProviders("", ["github", "google"])).toEqual([]);
  });
});

describe("loadDiscoveryCatalog", () => {
  it("returns enabled rows only, sorted, with defaulted descriptions", async () => {
    const { db } = mockDb(catalogRows);
    const catalog = await loadDiscoveryCatalog(db, ["github", "google"]);
    expect(catalog).toEqual([
      {
        provider: "github",
        tool: "list_pull_requests",
        displayName: "List pull requests",
        description: "List PRs in a repo.",
        category: "repos",
        action: "read",
      },
      {
        provider: "google",
        tool: "search_email",
        description: "",
        category: "mail",
        action: "read",
      },
    ]);
  });

  it("returns empty for no grants without touching the database", async () => {
    const { db } = mockDb();
    expect(await loadDiscoveryCatalog(db, [])).toEqual([]);
  });
});
