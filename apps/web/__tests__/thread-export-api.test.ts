import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@ai-workspace/auth";
import type { ThreadMessageWithActivity } from "@/lib/thread-messages";

const session: SessionUser = {
  id: "user-uuid",
  email: "user@example.com",
  displayName: "User",
  role: "user",
};

const fixedDate = new Date("2026-06-15T12:00:00.000Z");

let currentSession: SessionUser | null = session;
let threadRows: Array<{ id: string; title: string | null; userId: string }> = [];
let messages: ThreadMessageWithActivity[] = [];
let loadedThreadId: string | undefined;

function installMocks() {
  vi.doMock("@/lib/auth/getSessionUser", () => ({
    getSessionUser: async () => currentSession,
  }));
  vi.doMock("@/lib/thread-messages", () => ({
    loadThreadMessagesWithRunActivity: async ({
      threadId,
    }: {
      threadId: string;
    }) => {
      loadedThreadId = threadId;
      return messages;
    },
  }));
  vi.doMock("@ai-workspace/db", async () => {
    const actual =
      await vi.importActual<typeof import("@ai-workspace/db")>(
        "@ai-workspace/db",
      );
    const query: Record<string, unknown> = {};
    query.from = () => query;
    query.where = () => query;
    query.limit = () => Promise.resolve(threadRows);
    return {
      ...actual,
      getDb: () =>
        ({
          select: () => query,
        }) as never,
    };
  });
}

beforeEach(() => {
  currentSession = session;
  threadRows = [{ id: "thread-1", title: "Smoke transcript", userId: session.id }];
  messages = [
    {
      id: "message-1",
      role: "user",
      content: "Make a markdown artifact.",
      modelId: null,
      runtime: null,
      toolCalls: null,
      toolResults: null,
      createdAt: fixedDate,
    },
    {
      id: "message-2",
      role: "assistant",
      content: "Written to `smoke.md`.",
      modelId: "claude-sonnet-4-6",
      runtime: "bedrock",
      toolCalls: null,
      toolResults: null,
      artifacts: [
        {
          id: "artifact-1",
          title: "Smoke",
          filename: "smoke.md",
          kind: "markdown",
          mimeType: "text/markdown",
          sizeBytes: 128,
          source: "assistant-code-block",
          threadId: "thread-1",
          chatMessageId: "message-2",
          runId: "run-1",
          artifactGroupId: "artifact-group-1",
          versionNumber: 1,
          supersedesArtifactId: null,
          versionSummary: null,
          metadata: null,
          createdAt: fixedDate.toISOString(),
          previewUrl: "/workspace/artifacts/artifact-1",
          downloadUrl: "/api/workspace/artifacts/artifact-1/download",
        },
      ],
      runId: "run-1",
      runStatus: "succeeded",
      createdAt: fixedDate,
    },
  ];
  loadedThreadId = undefined;
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("GET /api/threads/[id]/export", () => {
  it("returns 401 without a session", async () => {
    currentSession = null;
    installMocks();

    const { GET } = await import("@/app/api/threads/[id]/export/route");
    const res = await GET(new Request("http://localhost/api/threads/thread-1/export"), {
      params: Promise.resolve({ id: "thread-1" }),
    });

    expect(res.status).toBe(401);
  });

  it("returns 404 when the thread is not visible to the session", async () => {
    threadRows = [];
    installMocks();

    const { GET } = await import("@/app/api/threads/[id]/export/route");
    const res = await GET(new Request("http://localhost/api/threads/nope/export"), {
      params: Promise.resolve({ id: "nope" }),
    });

    expect(res.status).toBe(404);
  });

  it("returns a protected markdown transcript with artifact details", async () => {
    installMocks();

    const { GET } = await import("@/app/api/threads/[id]/export/route");
    const res = await GET(new Request("http://localhost/api/threads/thread-1/export"), {
      params: Promise.resolve({ id: "thread-1" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("content-disposition")).toContain(".md");
    expect(loadedThreadId).toBe("thread-1");

    const markdown = await res.text();
    expect(markdown).toContain("# Smoke transcript");
    expect(markdown).toContain("- Thread ID: thread-1");
    expect(markdown).toContain("## 2. Assistant - claude-sonnet-4-6");
    expect(markdown).toContain("smoke.md (markdown, 128 B)");
  });
});
