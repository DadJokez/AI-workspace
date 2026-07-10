import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("GOOGLE_CLIENT_ID", "google-client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-client-secret");
  vi.stubEnv("OAUTH_ENCRYPTION_KEY", Buffer.alloc(32, 6).toString("base64"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Google token lifecycle", () => {
  it("uses an unexpired, sufficiently scoped encrypted access token", async () => {
    const { encryptSecret } = await import("@/lib/oauth/crypto");
    const db = fakeDb([
      {
        accessToken: encryptSecret("active-token"),
        refreshToken: encryptSecret("refresh-token"),
        expiresAt: new Date("2026-07-09T22:00:00.000Z"),
        scope: requiredScopes(),
      },
    ]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { resolveGoogleConnection } = await import(
      "@/lib/oauth/google-token"
    );

    const state = await resolveGoogleConnection(
      db.value,
      "user-1",
      new Date("2026-07-09T20:00:00.000Z"),
    );

    expect(state).toMatchObject({ status: "ready", accessToken: "active-token" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes an expired access token and persists the replacement", async () => {
    const { encryptSecret, decryptSecret } = await import("@/lib/oauth/crypto");
    const db = fakeDb([
      {
        accessToken: encryptSecret("expired-token"),
        refreshToken: encryptSecret("refresh-token"),
        expiresAt: new Date("2026-07-09T19:00:00.000Z"),
        scope: requiredScopes(),
      },
    ]);
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: "new-token", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { resolveGoogleConnection } = await import(
      "@/lib/oauth/google-token"
    );

    const state = await resolveGoogleConnection(
      db.value,
      "user-1",
      new Date("2026-07-09T20:00:00.000Z"),
    );

    expect(state).toMatchObject({ status: "ready", accessToken: "new-token" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({ method: "POST", body: expect.any(URLSearchParams) }),
    );
    expect(decryptSecret(String(db.updated?.accessToken))).toBe("new-token");
    expect(db.updated?.expiresAt).toEqual(
      new Date("2026-07-09T21:00:00.000Z"),
    );
  });

  it("requires reconnect instead of pretending an old read-only grant is ready", async () => {
    const { encryptSecret } = await import("@/lib/oauth/crypto");
    const db = fakeDb([
      {
        accessToken: encryptSecret("active-token"),
        refreshToken: encryptSecret("refresh-token"),
        expiresAt: new Date("2026-07-09T22:00:00.000Z"),
        scope:
          "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly",
      },
    ]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { resolveGoogleConnection } = await import(
      "@/lib/oauth/google-token"
    );

    const state = await resolveGoogleConnection(
      db.value,
      "user-1",
      new Date("2026-07-09T20:00:00.000Z"),
    );

    expect(state).toMatchObject({
      status: "reconnect_required",
      reason: "insufficient_scope",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires reconnect when Google rejects the stored refresh grant", async () => {
    const { encryptSecret } = await import("@/lib/oauth/crypto");
    const db = fakeDb([
      {
        accessToken: encryptSecret("expired-token"),
        refreshToken: encryptSecret("refresh-token"),
        expiresAt: new Date("2026-07-09T19:00:00.000Z"),
        scope: requiredScopes(),
      },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const { resolveGoogleConnection } = await import(
      "@/lib/oauth/google-token"
    );

    const state = await resolveGoogleConnection(
      db.value,
      "user-1",
      new Date("2026-07-09T20:00:00.000Z"),
    );

    expect(state).toMatchObject({
      status: "reconnect_required",
      reason: "expired_grant",
    });
  });
});

function requiredScopes() {
  return [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events.owned",
  ].join(" ");
}

function fakeDb(rows: Array<Record<string, unknown>>) {
  let updated: Record<string, unknown> | undefined;
  const selectQuery: Record<string, unknown> = {};
  selectQuery.from = () => selectQuery;
  selectQuery.where = () => selectQuery;
  selectQuery.limit = async () => rows;
  const updateQuery: Record<string, unknown> = {};
  updateQuery.set = (value: Record<string, unknown>) => {
    updated = value;
    return updateQuery;
  };
  updateQuery.where = async () => undefined;
  return {
    value: {
      select: () => selectQuery,
      update: () => updateQuery,
    } as never,
    get updated() {
      return updated;
    },
  };
}
