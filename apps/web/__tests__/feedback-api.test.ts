import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@ai-workspace/auth";
import {
  FEEDBACK_SCREENSHOT_TOO_LARGE_MESSAGE,
  MAX_FEEDBACK_SCREENSHOT_DATA_URL_CHARS,
} from "@/lib/feedback-screenshots";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const THREAD_ID = "00000000-0000-4000-8000-000000000010";
const MESSAGE_ID = "00000000-0000-4000-8000-000000000011";
const RUN_ID = "00000000-0000-4000-8000-000000000012";
const ARTIFACT_ID = "00000000-0000-4000-8000-000000000013";
const fixedDate = new Date("2026-06-15T12:00:00.000Z");

const session: SessionUser = {
  id: USER_ID,
  email: "user@example.com",
  displayName: "User",
  role: "user",
};

let currentSession: SessionUser | null = session;
let selectQueues: Array<Array<Record<string, unknown>>> = [];
let insertReturning: Array<Record<string, unknown>> = [];
let capturedInsert: Record<string, unknown> | undefined;

function installMocks() {
  vi.doMock("@/lib/auth/getSessionUser", () => ({
    getSessionUser: async () => currentSession,
  }));
  vi.doMock("@ai-workspace/db", async () => {
    const actual =
      await vi.importActual<typeof import("@ai-workspace/db")>(
        "@ai-workspace/db",
      );

    const selectQuery: Record<string, unknown> = {};
    selectQuery.from = () => selectQuery;
    selectQuery.where = () => selectQuery;
    selectQuery.limit = () => Promise.resolve(selectQueues.shift() ?? []);

    const insertQuery: Record<string, unknown> = {};
    insertQuery.values = (values: Record<string, unknown>) => {
      capturedInsert = values;
      return insertQuery;
    };
    insertQuery.returning = () => Promise.resolve(insertReturning);

    return {
      ...actual,
      getDb: () =>
        ({
          select: () => selectQuery,
          insert: () => insertQuery,
        }) as never,
    };
  });
}

function makeReq(body: unknown) {
  return new Request("http://localhost/api/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  currentSession = session;
  selectQueues = [];
  capturedInsert = undefined;
  insertReturning = [
    {
      id: "00000000-0000-4000-8000-000000000099",
      status: "new",
      createdAt: fixedDate,
    },
  ];
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("POST /api/feedback", () => {
  it("returns 401 without a session", async () => {
    currentSession = null;
    installMocks();

    const { POST } = await import("@/app/api/feedback/route");
    const res = await POST(makeReq({ body: "The preview is blank." }));

    expect(res.status).toBe(401);
  });

  it("requires a report body", async () => {
    installMocks();

    const { POST } = await import("@/app/api/feedback/route");
    const res = await POST(makeReq({ body: "   " }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "body_required" });
  });

  it("rejects oversized screenshot payloads instead of truncating them", async () => {
    installMocks();

    const { POST } = await import("@/app/api/feedback/route");
    const prefix = "data:image/png;base64,";
    const res = await POST(
      makeReq({
        body: "The screenshot should be rejected.",
        screenshotDataUrl: `${prefix}${"a".repeat(
          MAX_FEEDBACK_SCREENSHOT_DATA_URL_CHARS - prefix.length + 1,
        )}`,
      }),
    );

    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toMatchObject({
      error: "screenshot_too_large",
      message: FEEDBACK_SCREENSHOT_TOO_LARGE_MESSAGE,
    });
    expect(capturedInsert).toBeUndefined();
  });

  it("accepts screenshots at the configured 5 MB data URL limit", async () => {
    installMocks();

    const { POST } = await import("@/app/api/feedback/route");
    const prefix = "data:image/png;base64,";
    const screenshotDataUrl = `${prefix}${"a".repeat(
      MAX_FEEDBACK_SCREENSHOT_DATA_URL_CHARS - prefix.length,
    )}`;
    const res = await POST(
      makeReq({
        body: "The screenshot should be accepted.",
        screenshotDataUrl,
        screenshotName: "screen.png",
        screenshotMimeType: "image/png",
      }),
    );

    expect(res.status).toBe(201);
    expect(capturedInsert).toMatchObject({
      screenshotDataUrl,
      screenshotName: "screen.png",
      screenshotMimeType: "image/png",
    });
  });

  it("rejects oversized context metadata instead of storing hidden blobs", async () => {
    installMocks();

    const { POST } = await import("@/app/api/feedback/route");
    const res = await POST(
      makeReq({
        body: "The context payload should be rejected.",
        context: { notes: "x".repeat(8_001) },
      }),
    );

    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toMatchObject({
      error: "metadata_too_large",
    });
    expect(capturedInsert).toBeUndefined();
  });

  it("rejects oversized viewport metadata instead of storing hidden blobs", async () => {
    installMocks();

    const { POST } = await import("@/app/api/feedback/route");
    const res = await POST(
      makeReq({
        body: "The viewport payload should be rejected.",
        viewport: { layout: "x".repeat(8_001) },
      }),
    );

    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toMatchObject({
      error: "metadata_too_large",
    });
    expect(capturedInsert).toBeUndefined();
  });

  it("drops unsafe page URLs before storing admin-clickable links", async () => {
    installMocks();

    const { POST } = await import("@/app/api/feedback/route");
    const res = await POST(
      makeReq({
        body: "The admin link must not execute script.",
        pageUrl: "javascript:fetch('/api/admin/users')",
      }),
    );

    expect(res.status).toBe(201);
    expect(capturedInsert?.pageUrl).toBeUndefined();
  });

  it("rejects SVG screenshots before they can be rendered in admin", async () => {
    installMocks();

    const { POST } = await import("@/app/api/feedback/route");
    const res = await POST(
      makeReq({
        body: "SVG screenshots are not allowed.",
        screenshotDataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
        screenshotMimeType: "image/svg+xml",
      }),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "invalid_screenshot",
    });
    expect(capturedInsert).toBeUndefined();
  });

  it("rejects external screenshot URLs even when a safe MIME type is declared", async () => {
    installMocks();

    const { POST } = await import("@/app/api/feedback/route");
    const res = await POST(
      makeReq({
        body: "External image URLs are not screenshots.",
        screenshotDataUrl: "https://attacker.example/pixel.png",
        screenshotMimeType: "image/png",
      }),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "invalid_screenshot",
    });
    expect(capturedInsert).toBeUndefined();
  });

  it("stores a scoped feedback report with visible context", async () => {
    selectQueues = [
      [{ id: THREAD_ID }],
      [{ id: MESSAGE_ID }],
      [{ id: RUN_ID }],
      [{ id: ARTIFACT_ID }],
    ];
    installMocks();

    const { POST } = await import("@/app/api/feedback/route");
    const res = await POST(
      makeReq({
        type: "performance",
        severity: "high",
        body: "The first token took ten seconds.",
        expected: "It should start streaming quickly.",
        includeContext: true,
        pageUrl: "https://app.comparative.example/chat",
        userAgent: "Vitest",
        viewport: { width: 1200, height: 800 },
        context: {
          threadId: THREAD_ID,
          messageId: MESSAGE_ID,
          runId: RUN_ID,
          artifactId: ARTIFACT_ID,
          threadTitle: "Slow chat",
        },
      }),
    );

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      report: { id: "00000000-0000-4000-8000-000000000099", status: "new" },
    });
    expect(capturedInsert).toMatchObject({
      userId: USER_ID,
      threadId: THREAD_ID,
      chatMessageId: MESSAGE_ID,
      runId: RUN_ID,
      artifactId: ARTIFACT_ID,
      type: "performance",
      severity: "high",
      title: "The first token took ten seconds.",
      body: "The first token took ten seconds.",
      expected: "It should start streaming quickly.",
      pageUrl: "https://app.comparative.example/chat",
    });
  });

  it("rejects context for a thread the user cannot see", async () => {
    selectQueues = [[]];
    installMocks();

    const { POST } = await import("@/app/api/feedback/route");
    const res = await POST(
      makeReq({
        body: "This is attached to another user's thread.",
        context: { threadId: THREAD_ID },
      }),
    );

    expect(res.status).toBe(404);
    expect(capturedInsert).toBeUndefined();
  });
});
