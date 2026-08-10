import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apps: {
    id: "apps.id",
    ownerUserId: "apps.ownerUserId",
    archivedAt: "apps.archivedAt",
    updatedAt: "apps.updatedAt",
  },
  chatThreads: {
    id: "chatThreads.id",
    userId: "chatThreads.userId",
    title: "chatThreads.title",
    previewSummary: "chatThreads.previewSummary",
    pinned: "chatThreads.pinned",
    updatedAt: "chatThreads.updatedAt",
  },
  skills: {
    id: "skills.id",
    ownerUserId: "skills.ownerUserId",
    archivedAt: "skills.archivedAt",
    isStarter: "skills.isStarter",
    updatedAt: "skills.updatedAt",
  },
  listAppSharesWithRoles: vi.fn(),
  listAppVersions: vi.fn(),
  listSkillsSharedWith: vi.fn(),
  loadToolCatalogForProviders: vi.fn(),
  loadUserMcpProviderStatus: vi.fn(),
  loadUserMemoryItems: vi.fn(),
  loadWorkspaceArtifacts: vi.fn(),
}));

vi.mock("@ai-workspace/db", () => ({
  apps: mocks.apps,
  chatThreads: mocks.chatThreads,
  skills: mocks.skills,
}));
vi.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => ({ op: "and", conditions }),
  desc: (column: unknown) => ({ op: "desc", column }),
  eq: (column: unknown, value: unknown) => ({ op: "eq", column, value }),
  isNull: (column: unknown) => ({ op: "isNull", column }),
  or: (...conditions: unknown[]) => ({ op: "or", conditions }),
}));
vi.mock("@/lib/apps", () => ({
  canAppRoleEdit: (role: string) => role === "owner" || role === "editor",
  listAppSharesWithRoles: mocks.listAppSharesWithRoles,
  listAppVersions: mocks.listAppVersions,
}));
vi.mock("@/lib/oauth/mcp-servers", () => ({
  SUPPORTED_MCP_PROVIDERS: ["github"],
  loadUserMcpProviderStatus: mocks.loadUserMcpProviderStatus,
}));
vi.mock("@/lib/output-proposals", () => ({
  outputProposalFromMetadata: () => null,
}));
vi.mock("@/lib/shares", () => ({
  listSkillsSharedWith: mocks.listSkillsSharedWith,
}));
vi.mock("@/lib/settings-navigation", () => ({
  INTEGRATION_DISPLAY_NAMES: {},
}));
vi.mock("@/lib/starter-skills", () => ({
  canonicalizeStarterSkill: (skill: unknown) => skill,
}));
vi.mock("@/lib/tool-attestations", () => ({
  loadToolCatalogForProviders: mocks.loadToolCatalogForProviders,
}));
vi.mock("@/lib/vault-memory", () => ({
  loadUserMemoryItems: mocks.loadUserMemoryItems,
}));
vi.mock("@/lib/workspace-artifacts", () => ({
  loadWorkspaceArtifacts: mocks.loadWorkspaceArtifacts,
}));

import { loadCommandPaletteIndex } from "@/lib/command-palette-server";

const user = {
  id: "user-owner",
  email: "casey@example.com",
  displayName: "Casey",
  role: "user",
};
const now = new Date("2026-08-10T12:00:00.000Z");

function fakeDb() {
  const rows = new Map<unknown, unknown[]>([
    [
      mocks.chatThreads,
      [
        {
          id: "thread-owned",
          title: "Owned launch plan",
          previewSummary: "Only Casey can see this chat.",
          pinned: false,
          updatedAt: now,
        },
      ],
    ],
    [
      mocks.skills,
      [
        {
          id: "skill-owned",
          ownerUserId: user.id,
          slug: "owned-skill",
          name: "Owned Skill",
          description: "A private Skill.",
          mcpProviders: [],
          isStarter: false,
          archivedAt: null,
          updatedAt: now,
        },
      ],
    ],
    [
      mocks.apps,
      [
        {
          id: "app-owned",
          ownerUserId: user.id,
          slug: "owned-app",
          name: "Owned App",
          description: "A private app.",
          status: "draft",
          archivedAt: null,
          updatedAt: now,
          liveArtifactId: null,
          liveVersionId: null,
        },
      ],
    ],
  ]);
  const whereCalls: unknown[] = [];
  return {
    whereCalls,
    db: {
      select: () => {
        let table: unknown;
        const query = {
          from(nextTable: unknown) {
            table = nextTable;
            return query;
          },
          where(condition: unknown) {
            whereCalls.push(condition);
            return query;
          },
          orderBy() {
            return query;
          },
          limit() {
            return Promise.resolve(rows.get(table) ?? []);
          },
          then<TResult1 = unknown[], TResult2 = never>(
            onfulfilled?:
              | ((value: unknown[]) => TResult1 | PromiseLike<TResult1>)
              | null,
            onrejected?:
              | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
              | null,
          ) {
            return Promise.resolve(rows.get(table) ?? []).then(
              onfulfilled,
              onrejected,
            );
          },
        };
        return query;
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listAppSharesWithRoles.mockResolvedValue([]);
  mocks.listAppVersions.mockResolvedValue([]);
  mocks.listSkillsSharedWith.mockResolvedValue([]);
  mocks.loadToolCatalogForProviders.mockResolvedValue([
    {
      provider: "github",
      toolName: "delete_repository",
      category: "repository",
      action: "delete",
      enabled: true,
    },
  ]);
  mocks.loadUserMcpProviderStatus.mockResolvedValue({
    connectedProviders: ["github"],
    allowedProviders: ["github"],
    deniedProviders: [],
    toolPolicies: { github: { blockedTools: ["delete_repository"] } },
    providerAvailability: {
      github: {
        connected: true,
        tokenValid: true,
        userApproved: true,
        executionConfigured: true,
        toolMountable: true,
        modelAvailable: true,
        status: "ready",
      },
    },
  });
  mocks.loadUserMemoryItems.mockResolvedValue([
    {
      id: "memory-owned",
      title: "Preferred answer style",
      bodyMd: "Keep answers direct.",
      category: "working_style",
      sourceThreadId: "thread-owned",
      updatedAt: now,
    },
  ]);
  mocks.loadWorkspaceArtifacts.mockResolvedValue([
    {
      id: "artifact-owned",
      title: "Owned artifact",
      filename: "owned.md",
      kind: "markdown",
      mimeType: "text/markdown",
      sizeBytes: 42,
      source: "chat",
      threadId: "thread-owned",
      chatMessageId: "message-owned",
      runId: "run-owned",
      artifactGroupId: "artifact-owned",
      versionNumber: 1,
      supersedesArtifactId: null,
      versionSummary: null,
      metadata: { privateReceipt: "must-not-cross-boundary" },
      createdAt: now.toISOString(),
      previewUrl: "/preview",
      downloadUrl: "/download",
    },
  ]);
});

describe("loadCommandPaletteIndex", () => {
  it("scopes every resource source to the caller before projecting results", async () => {
    const { db, whereCalls } = fakeDb();

    const result = await loadCommandPaletteIndex({
      db: db as never,
      user: user as never,
      currentThreadId: "thread-owned",
    });

    expect(mocks.loadWorkspaceArtifacts).toHaveBeenCalledWith({
      db,
      userId: user.id,
      limit: 75,
    });
    expect(mocks.loadUserMemoryItems).toHaveBeenCalledWith(db, user.id, [
      "approved",
    ]);
    expect(mocks.listSkillsSharedWith).toHaveBeenCalledWith(db, user.id);
    expect(mocks.listAppSharesWithRoles).toHaveBeenCalledWith(db, user.id);
    const serializedScopes = JSON.stringify(whereCalls);
    expect(serializedScopes).toContain(
      `\"column\":\"chatThreads.userId\",\"value\":\"${user.id}\"`,
    );
    expect(serializedScopes).toContain(
      `\"column\":\"skills.ownerUserId\",\"value\":\"${user.id}\"`,
    );
    expect(serializedScopes).toContain(
      `\"column\":\"apps.ownerUserId\",\"value\":\"${user.id}\"`,
    );
    expect(result.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "thread:thread-owned",
        "artifact:artifact-owned",
        "vault:memory-owned",
        "skill:skill-owned",
        "app:app-owned",
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("must-not-cross-boundary");
    expect(
      result.items.find(
        (item) => item.id === "tool:github:delete_repository",
      ),
    ).toMatchObject({
      readiness: {
        state: "policy_blocked",
        label: "Blocked",
        detail: expect.stringContaining("Ask an admin"),
      },
    });
  });

  it("returns healthy sections and names a failed section as partial", async () => {
    const { db } = fakeDb();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.loadUserMemoryItems.mockRejectedValueOnce(new Error("vault timeout"));

    const result = await loadCommandPaletteIndex({
      db: db as never,
      user: user as never,
    });

    expect(result.partialSections).toContain("vault");
    expect(result.items.some((item) => item.group === "chats")).toBe(true);
    expect(result.items.some((item) => item.group === "vault")).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "[command-palette] vault index section failed:",
      expect.any(Error),
    );
    warn.mockRestore();
  });
});
