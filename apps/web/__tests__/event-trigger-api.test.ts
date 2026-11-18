import type { SessionUser } from "@ai-workspace/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const TRIGGER_ID = "00000000-0000-4000-8000-000000000293";
const session: SessionUser = {
  id: USER_ID,
  email: "user@example.com",
  displayName: "User",
  role: "user",
};

let currentSession: SessionUser | null = session;
let updateRows: Array<Record<string, unknown>> = [];
let selectRows: Array<Record<string, unknown>> = [];
const updates: Array<Record<string, unknown>> = [];
const inserts: Array<Record<string, unknown>> = [];

function installMocks() {
  vi.doMock("@/lib/auth/getSessionUser", () => ({
    getSessionUser: async () => currentSession,
  }));
  vi.doMock("@ai-workspace/db", async () => {
    const actual =
      await vi.importActual<typeof import("@ai-workspace/db")>(
        "@ai-workspace/db",
      );
    return {
      ...actual,
      getDb: () =>
        ({
          select: () => ({
            from: () => ({
              where: () => ({ limit: async () => selectRows }),
            }),
          }),
          update: () => ({
            set: (values: Record<string, unknown>) => {
              updates.push(values);
              return {
                where: () => ({
                  returning: async () => updateRows,
                }),
              };
            },
          }),
          insert: () => ({
            values: async (values: Record<string, unknown>) => {
              inserts.push(values);
            },
          }),
        }) as never,
    };
  });
}

function patchRequest(enabled: unknown) {
  return new Request(`http://localhost/api/event-triggers/${TRIGGER_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

beforeEach(() => {
  currentSession = session;
  updateRows = [];
  selectRows = [];
  updates.length = 0;
  inserts.length = 0;
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe("/api/event-triggers/[id]", () => {
  it("requires an authenticated owner", async () => {
    currentSession = null;
    installMocks();
    const { PATCH } = await import("@/app/api/event-triggers/[id]/route");

    const response = await PATCH(patchRequest(false), {
      params: Promise.resolve({ id: TRIGGER_ID }),
    });

    expect(response.status).toBe(401);
    expect(updates).toHaveLength(0);
  });

  it("returns not found when the owner-scoped update matches no trigger", async () => {
    installMocks();
    const { PATCH } = await import("@/app/api/event-triggers/[id]/route");

    const response = await PATCH(patchRequest(false), {
      params: Promise.resolve({ id: "another-users-trigger" }),
    });

    expect(response.status).toBe(404);
    expect(inserts).toHaveLength(0);
  });

  it("pauses an owned trigger and audits the mutation", async () => {
    updateRows = [
      {
        id: TRIGGER_ID,
        userId: USER_ID,
        eventType: "pull_request_review",
        enabled: false,
      },
    ];
    installMocks();
    const { PATCH } = await import("@/app/api/event-triggers/[id]/route");

    const response = await PATCH(patchRequest(false), {
      params: Promise.resolve({ id: TRIGGER_ID }),
    });

    expect(response.status).toBe(200);
    expect(updates[0]).toMatchObject({ enabled: false });
    expect(inserts[0]).toMatchObject({
      actorUserId: USER_ID,
      actionType: "event_trigger_update",
      metadata: { enabled: false },
    });
  });

  it("soft-deletes an owned trigger so run provenance remains", async () => {
    updateRows = [
      {
        id: TRIGGER_ID,
        userId: USER_ID,
        eventType: "workflow_run",
      },
    ];
    installMocks();
    const { DELETE } = await import("@/app/api/event-triggers/[id]/route");

    const response = await DELETE(
      new Request(`http://localhost/api/event-triggers/${TRIGGER_ID}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: TRIGGER_ID }) },
    );

    expect(response.status).toBe(200);
    expect(updates[0]).toMatchObject({ enabled: false });
    expect(updates[0]?.deletedAt).toBeInstanceOf(Date);
    expect(inserts[0]).toMatchObject({
      actorUserId: USER_ID,
      actionType: "event_trigger_delete",
    });
  });

  it("starts the poll cursor over when a trigger is resumed", async () => {
    updateRows = [
      { id: TRIGGER_ID, userId: USER_ID, eventType: "pull_request_review" },
    ];
    installMocks();
    const { PATCH } = await import("@/app/api/event-triggers/[id]/route");

    const response = await PATCH(patchRequest(true), {
      params: Promise.resolve({ id: TRIGGER_ID }),
    });

    expect(response.status).toBe(200);
    expect(updates[0]).toMatchObject({
      enabled: true,
      pollState: null,
      pollNextAt: null,
    });
  });

  it("refuses to resume a failed-CI trigger in poll mode and says why", async () => {
    vi.stubEnv("GITHUB_EVENT_INGEST_MODE", "poll");
    selectRows = [{ eventType: "workflow_run" }];
    installMocks();
    const { PATCH } = await import("@/app/api/event-triggers/[id]/route");

    const response = await PATCH(patchRequest(true), {
      params: Promise.resolve({ id: TRIGGER_ID }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "event_trigger_unavailable",
      message: expect.stringContaining("does not include workflow runs"),
    });
    expect(updates).toHaveLength(0);
  });

  it("still lets a failed-CI trigger be paused in poll mode", async () => {
    vi.stubEnv("GITHUB_EVENT_INGEST_MODE", "poll");
    selectRows = [{ eventType: "workflow_run" }];
    updateRows = [{ id: TRIGGER_ID, userId: USER_ID, eventType: "workflow_run" }];
    installMocks();
    const { PATCH } = await import("@/app/api/event-triggers/[id]/route");

    const response = await PATCH(patchRequest(false), {
      params: Promise.resolve({ id: TRIGGER_ID }),
    });

    expect(response.status).toBe(200);
    expect(updates[0]).toMatchObject({ enabled: false });
  });

  it("rejects malformed enable state", async () => {
    installMocks();
    const { PATCH } = await import("@/app/api/event-triggers/[id]/route");

    const response = await PATCH(patchRequest("yes"), {
      params: Promise.resolve({ id: TRIGGER_ID }),
    });

    expect(response.status).toBe(400);
    expect(updates).toHaveLength(0);
  });
});
