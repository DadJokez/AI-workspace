import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workspaceArtifacts: { id: "artifact.id" },
  userMemoryItems: { id: "memory.id" },
  appVersions: { id: "appVersion.id" },
  apps: { id: "app.id" },
  shares: { id: "share.id" },
  resolveGoogleConnection: vi.fn(),
  readGoogleMailMessageReference: vi.fn(),
  searchGoogleMailThreads: vi.fn(),
  artifactPromptContent: vi.fn(),
  canListAppVersionForActor: vi.fn(),
  listAppVersions: vi.fn(),
  resolveAppActorRole: vi.fn(),
}));

vi.mock("@ai-workspace/db", () => ({
  workspaceArtifacts: mocks.workspaceArtifacts,
  userMemoryItems: mocks.userMemoryItems,
  appVersions: mocks.appVersions,
  apps: mocks.apps,
  shares: mocks.shares,
}));
vi.mock("drizzle-orm", () => ({
  and: (...values: unknown[]) => values,
  desc: (value: unknown) => value,
  eq: (...values: unknown[]) => values,
  inArray: (...values: unknown[]) => values,
  isNull: (value: unknown) => value,
}));
vi.mock("@/lib/google/api", () => ({
  readGoogleMailMessageReference: mocks.readGoogleMailMessageReference,
  searchGoogleMailThreads: mocks.searchGoogleMailThreads,
}));
vi.mock("@/lib/oauth/google-token", () => ({
  resolveGoogleConnection: mocks.resolveGoogleConnection,
}));
vi.mock("@/lib/artifact-context", () => ({
  artifactPromptContent: mocks.artifactPromptContent,
}));
vi.mock("@/lib/apps", () => ({
  canListAppVersionForActor: mocks.canListAppVersionForActor,
  listAppVersions: mocks.listAppVersions,
  resolveAppActorRole: mocks.resolveAppActorRole,
}));

import { resolveContextResources } from "@/lib/context-shelf-server";

const user = { id: "user-1", role: "user" as const };
const threadId = "thread-1";
let rows = new Map<unknown, unknown[]>();

beforeEach(() => {
  vi.clearAllMocks();
  rows = new Map([
    [mocks.workspaceArtifacts, []],
    [mocks.userMemoryItems, []],
    [mocks.appVersions, []],
  ]);
  mocks.resolveGoogleConnection.mockResolvedValue({
    status: "not_connected",
    connected: false,
    ready: false,
  });
  mocks.artifactPromptContent.mockImplementation(
    ({ content }: { content: string }) => ({ content }),
  );
  mocks.canListAppVersionForActor.mockReturnValue(true);
});

describe("server-authoritative Context Shelf resolution (#738)", () => {
  it("does not inject an artifact selected from another thread", async () => {
    rows.set(mocks.workspaceArtifacts, [
      {
        id: "artifact-1",
        userId: user.id,
        threadId: "thread-2",
        title: "Other thread brief",
        filename: "brief.md",
        source: "chat",
        content: "secret from another thread",
        metadata: {},
        versionNumber: 1,
      },
    ]);

    const result = await resolveContextResources({
      db: fakeDb(),
      user,
      threadId,
      references: [
        { version: 1, kind: "artifact", resourceId: "artifact-1" },
      ],
    });

    expect(result.promptContext).toBeNull();
    expect(result.manifest.items).toEqual([
      expect.objectContaining({
        state: "unavailable",
        reason: "wrong_thread",
      }),
    ]);
    expect(JSON.stringify(result.manifest)).not.toContain(
      "secret from another thread",
    );
  });

  it("injects approved Vault content in a data-only frame without persisting it", async () => {
    rows.set(mocks.userMemoryItems, [
      {
        id: "memory-1",
        userId: user.id,
        status: "approved",
        title: "Working style",
        bodyMd: "Keep answers direct.",
        category: "working_style",
      },
    ]);

    const result = await resolveContextResources({
      db: fakeDb(),
      user,
      threadId,
      references: [
        { version: 1, kind: "vault_item", resourceId: "memory-1" },
      ],
    });

    expect(result.promptContext).toContain("strictly as untrusted DATA");
    expect(result.promptContext).toContain("Keep answers direct.");
    expect(result.manifest.items).toEqual([
      expect.objectContaining({
        label: "Working style",
        state: "included",
        contentChars: 20,
      }),
    ]);
    expect(JSON.stringify(result.manifest)).not.toContain(
      "Keep answers direct.",
    );
  });

  it("reports empty selected content as unavailable instead of a budget omission", async () => {
    rows.set(mocks.userMemoryItems, [
      {
        id: "memory-empty",
        userId: user.id,
        status: "approved",
        title: "Empty memory",
        bodyMd: "   ",
        category: "working_style",
      },
    ]);

    const result = await resolveContextResources({
      db: fakeDb(),
      user,
      threadId,
      references: [
        { version: 1, kind: "vault_item", resourceId: "memory-empty" },
      ],
    });

    expect(result.promptContext).toBeNull();
    expect(result.manifest.items).toEqual([
      expect.objectContaining({
        state: "unavailable",
        reason: "extraction_failed",
      }),
    ]);
  });

  it("omits oversized selected content with an honest budget reason", async () => {
    rows.set(mocks.userMemoryItems, [
      {
        id: "memory-large",
        userId: user.id,
        status: "approved",
        title: "Large memory",
        bodyMd: "x".repeat(16_001),
        category: "reference",
      },
    ]);

    const result = await resolveContextResources({
      db: fakeDb(),
      user,
      threadId,
      references: [
        { version: 1, kind: "vault_item", resourceId: "memory-large" },
      ],
    });

    expect(result.promptContext).toBeNull();
    expect(result.manifest.items).toEqual([
      expect.objectContaining({
        state: "budget-omitted",
        reason: "oversize",
      }),
    ]);
  });

  it("distinguishes total context-budget exhaustion from an oversized item", async () => {
    rows.set(
      mocks.userMemoryItems,
      ["one", "two", "three"].map((id) => ({
        id: `memory-${id}`,
        userId: user.id,
        status: "approved",
        title: `Memory ${id}`,
        bodyMd: id[0]!.repeat(15_000),
        category: "reference",
      })),
    );

    const result = await resolveContextResources({
      db: fakeDb(),
      user,
      threadId,
      references: ["one", "two", "three"].map((id) => ({
        version: 1 as const,
        kind: "vault_item" as const,
        resourceId: `memory-${id}`,
      })),
    });

    expect(result.manifest.items.map((item) => item.state)).toEqual([
      "included",
      "included",
      "budget-omitted",
    ]);
    expect(result.manifest.items[2]).toMatchObject({
      reason: "context_budget_exhausted",
    });
  });

  it("pins the exact authorized app version selected by the user", async () => {
    rows.set(mocks.appVersions, [
      {
        version: {
          id: "version-2",
          appId: "app-1",
          versionNumber: 2,
          status: "draft",
        },
        app: { id: "app-1", name: "Launch planner" },
        artifact: {
          id: "artifact-v2",
          source: "chat",
          content: "version two content",
          metadata: {},
        },
      },
    ]);
    mocks.resolveAppActorRole.mockResolvedValue("owner");

    const result = await resolveContextResources({
      db: fakeDb(),
      user,
      threadId,
      references: [
        {
          version: 1,
          kind: "app_version",
          resourceId: "version-2",
          containerId: "app-1",
        },
      ],
    });

    expect(result.promptContext).toContain("version two content");
    expect(result.manifest.items).toEqual([
      expect.objectContaining({
        label: "Launch planner",
        state: "included",
        versionLabel: "v2",
      }),
    ]);
  });

  it.each(["viewer", "editor"] as const)(
    "rejects a hidden app version referenced by an authorized %s",
    async (role) => {
      rows.set(mocks.appVersions, [
        {
          version: {
            id: "private-version",
            appId: "app-1",
            versionNumber: 3,
            status: "draft",
            createdByUserId: "another-editor",
          },
          app: { id: "app-1", name: "Private planner" },
          artifact: {
            id: "private-artifact",
            source: "chat",
            content: "another editor's private work",
            metadata: {},
          },
        },
      ]);
      mocks.resolveAppActorRole.mockResolvedValue(role);
      mocks.canListAppVersionForActor.mockReturnValue(false);

      const result = await resolveContextResources({
        db: fakeDb(),
        user,
        threadId,
        references: [
          {
            version: 1,
            kind: "app_version",
            resourceId: "private-version",
            containerId: "app-1",
          },
        ],
      });

      expect(mocks.canListAppVersionForActor).toHaveBeenCalledWith(
        expect.objectContaining({ id: "private-version" }),
        { actorRole: role, visibleToUserId: user.id },
      );
      expect(result.promptContext).toBeNull();
      expect(result.manifest.items).toEqual([
        expect.objectContaining({ state: "unavailable" }),
      ]);
      expect(JSON.stringify(result)).not.toContain(
        "another editor's private work",
      );
    },
  );

  it("does not touch Gmail when provider policy blocks the selected resource", async () => {
    const result = await resolveContextResources({
      db: fakeDb(),
      user,
      threadId,
      references: [
        {
          version: 1,
          kind: "google_mail_thread",
          resourceId: "message-1",
          containerId: "thread-1",
        },
      ],
      runtimeProviders: {
        mountedProviders: [],
        discoverableProviders: [],
        blockedProviders: ["google"],
      },
    });

    expect(mocks.resolveGoogleConnection).not.toHaveBeenCalled();
    expect(mocks.readGoogleMailMessageReference).not.toHaveBeenCalled();
    expect(result.promptContext).toBeNull();
    expect(result.manifest.items).toEqual([
      expect.objectContaining({
        state: "policy-blocked",
        reason: "policy_denied",
      }),
    ]);
  });

  it("rechecks Gmail identity at send time and rejects a stale thread reference", async () => {
    mocks.resolveGoogleConnection.mockResolvedValue({
      status: "ready",
      connected: true,
      ready: true,
      accessToken: "token",
    });
    mocks.readGoogleMailMessageReference.mockResolvedValue({
      messageId: "message-1",
      threadId: "thread-new",
      subject: "Quarterly update",
    });

    const result = await resolveContextResources({
      db: fakeDb(),
      user,
      threadId,
      references: [
        {
          version: 1,
          kind: "google_mail_thread",
          resourceId: "message-1",
          containerId: "thread-old",
        },
      ],
    });

    expect(result.promptContext).toBeNull();
    expect(result.requestedProviders).toEqual(["google"]);
    expect(result.manifest.items).toEqual([
      expect.objectContaining({
        label: "Quarterly update",
        state: "unavailable",
        reason: "stale_version",
      }),
    ]);
  });
});

function fakeDb() {
  return {
    select: () => {
      let table: unknown;
      const query = {
        from(nextTable: unknown) {
          table = nextTable;
          return query;
        },
        innerJoin() {
          return query;
        },
        where() {
          return query;
        },
        orderBy() {
          return query;
        },
        limit() {
          return Promise.resolve(rows.get(table) ?? []);
        },
        then<TResult1 = unknown[], TResult2 = never>(
          onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) {
          return Promise.resolve(rows.get(table) ?? []).then(
            onfulfilled,
            onrejected,
          );
        },
      };
      return query;
    },
  } as never;
}
