import type { SessionUser } from "@ai-workspace/auth";
import type { Database, StudioBrowserSession } from "@ai-workspace/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getStudioBrowserLiveView,
  getStudioBrowserSession,
  stopStudioBrowserSession,
  studioBrowserCapabilityFromEnv,
} from "@/lib/studio-browser";

const actor: SessionUser = {
  id: "00000000-0000-4000-8000-000000000801",
  email: "owner@example.com",
  displayName: "Owner",
  role: "user",
};

describe("Studio Browser session isolation", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("rejects an unowned session before calling the provider", async () => {
    const provider = providerHarness();
    const db = databaseHarness([]).db;

    await expect(
      getStudioBrowserSession({
        db,
        actor,
        sessionId: "00000000-0000-4000-8000-000000000899",
        dependencies: { provider },
      }),
    ).rejects.toMatchObject({
      code: "browser_session_not_found",
      status: 404,
    });
    expect(provider.status).not.toHaveBeenCalled();
    expect(provider.stop).not.toHaveBeenCalled();
  });

  it("expires and revokes an owned session without asking the provider for status", async () => {
    const provider = providerHarness();
    const session = sessionRow({
      expiresAt: new Date("2026-08-11T12:00:00.000Z"),
    });
    const harness = databaseHarness([session]);

    const result = await getStudioBrowserSession({
      db: harness.db,
      actor,
      sessionId: session.id,
      dependencies: {
        provider,
        now: () => new Date("2026-08-11T12:00:01.000Z"),
      },
    });

    expect(result.status).toBe("expired");
    expect(provider.stop).toHaveBeenCalledWith({
      browserIdentifier: session.browserIdentifier,
      providerSessionId: session.providerSessionId,
    });
    expect(provider.status).not.toHaveBeenCalled();
    expect(harness.sets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "expired" }),
        expect.objectContaining({ revokedAt: expect.any(Date) }),
      ]),
    );
  });

  it("does not mint a live view for an expired session", async () => {
    const provider = providerHarness();
    const session = sessionRow({
      expiresAt: new Date("2026-08-11T12:00:00.000Z"),
    });

    await expect(
      getStudioBrowserLiveView({
        db: databaseHarness([session]).db,
        actor,
        sessionId: session.id,
        dependencies: {
          provider,
          now: () => new Date("2026-08-11T12:00:01.000Z"),
        },
      }),
    ).rejects.toMatchObject({ code: "browser_session_expired", status: 410 });
    expect(provider.liveViewUrl).not.toHaveBeenCalled();
  });

  it("does not stop an unowned provider session", async () => {
    const provider = providerHarness();

    await expect(
      stopStudioBrowserSession({
        db: databaseHarness([]).db,
        actor,
        sessionId: "00000000-0000-4000-8000-000000000899",
        dependencies: { provider },
      }),
    ).rejects.toMatchObject({ code: "browser_session_not_found", status: 404 });
    expect(provider.stop).not.toHaveBeenCalled();
  });

  it("keeps the capability off when the proxy port is malformed", () => {
    vi.stubEnv("AGENTCORE_BROWSER_ENABLED", "1");
    vi.stubEnv("AGENTCORE_BROWSER_ID", "browser-1");
    vi.stubEnv("AGENTCORE_BROWSER_PROXY_HOST", "browser-proxy.internal");
    vi.stubEnv("AGENTCORE_BROWSER_PROXY_SECRET_ARN", "arn:aws:secretsmanager:x");
    vi.stubEnv("AGENTCORE_BROWSER_PROXY_PORT", "not-a-port");

    expect(studioBrowserCapabilityFromEnv()).toBe(false);
  });
});

function providerHarness() {
  return {
    start: vi.fn(),
    navigate: vi.fn(),
    action: vi.fn(),
    status: vi.fn().mockResolvedValue("READY"),
    liveViewUrl: vi.fn(),
    screenshot: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

function databaseHarness(rows: StudioBrowserSession[]) {
  const sets: unknown[] = [];
  const select = vi.fn(() => selectQuery(rows));
  const update = vi.fn(() => mutationQuery(sets));
  const tx = { update };
  const db = {
    select,
    update,
    transaction: vi.fn(async (callback: (value: typeof tx) => unknown) =>
      callback(tx),
    ),
  } as unknown as Database;
  return { db, sets };
}

function selectQuery<T>(rows: T[]) {
  const query = {
    from: () => query,
    where: () => query,
    limit: () => Promise.resolve(rows),
  };
  return query;
}

function mutationQuery(sets: unknown[]) {
  const query = {
    set(value: unknown) {
      sets.push(value);
      return query;
    },
    where: () => Promise.resolve([]),
  };
  return query;
}

function sessionRow(
  overrides: Partial<StudioBrowserSession> = {},
): StudioBrowserSession {
  return {
    id: "00000000-0000-4000-8000-000000000810",
    userId: actor.id,
    threadId: "00000000-0000-4000-8000-000000000811",
    runId: "00000000-0000-4000-8000-000000000812",
    providerSessionId: "provider-session-1",
    browserIdentifier: "browser-1",
    targetKind: "public",
    targetResourceId: "message-1:1",
    displayUrl: "https://example.com/evidence",
    origin: "https://example.com",
    status: "ready",
    viewportWidth: 1440,
    viewportHeight: 900,
    expiresAt: new Date("2026-08-11T12:15:00.000Z"),
    stoppedAt: null,
    lastError: null,
    metadata: null,
    createdAt: new Date("2026-08-11T12:00:00.000Z"),
    updatedAt: new Date("2026-08-11T12:00:00.000Z"),
    ...overrides,
  };
}
