import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@ai-workspace/auth";

const session: SessionUser = {
  id: "00000000-0000-4000-8000-000000000297",
  email: "user@example.com",
  displayName: "User",
  role: "user",
};

let currentSession: SessionUser | null = session;
let selectRows: Array<Record<string, unknown>> = [];
let capturedTokenValues: Record<string, unknown> | undefined;
let capturedAttestationValues: Record<string, unknown> | undefined;

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
    selectQuery.limit = async () => selectRows;

    return {
      ...actual,
      getDb: () =>
        ({
          select: () => selectQuery,
          insert: (table: unknown) => {
            const insertQuery: Record<string, unknown> = {};
            insertQuery.values = (values: Record<string, unknown>) => {
              if (table === actual.oauthTokens) {
                capturedTokenValues = values;
              } else if (table === actual.userToolAttestations) {
                capturedAttestationValues = values;
              }
              return insertQuery;
            };
            insertQuery.onConflictDoUpdate = async () => undefined;
            insertQuery.then = (resolve: (value: unknown) => void) =>
              resolve([]);
            return insertQuery;
          },
        }) as never,
    };
  });
}

beforeEach(() => {
  currentSession = session;
  selectRows = [];
  capturedTokenValues = undefined;
  capturedAttestationValues = undefined;
  vi.stubEnv("NEXTAUTH_URL", "https://comparative.example");
  vi.stubEnv("GOOGLE_CLIENT_ID", "google-client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-client-secret");
  vi.stubEnv(
    "OAUTH_ENCRYPTION_KEY",
    Buffer.alloc(32, 8).toString("base64"),
  );
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Google OAuth routes", () => {
  it("requests the approved Gmail and Calendar read/write scopes", async () => {
    installMocks();
    const { GET } = await import("@/app/api/oauth/google/start/route");

    const res = await GET();
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    const url = new URL(location!);
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(url.searchParams.get("client_id")).toBe("google-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://comparative.example/api/oauth/google/callback",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toContain(
      "https://www.googleapis.com/auth/gmail.readonly",
    );
    expect(url.searchParams.get("scope")).toContain(
      "https://www.googleapis.com/auth/gmail.compose",
    );
    expect(url.searchParams.get("scope")).toContain(
      "https://www.googleapis.com/auth/calendar.readonly",
    );
    expect(url.searchParams.get("scope")).toContain(
      "https://www.googleapis.com/auth/calendar.events.owned",
    );
    expect(res.headers.get("set-cookie")).toContain("google_oauth_state=");
  });

  it("stores encrypted Google tokens and creates a write provider attestation", async () => {
    selectRows = [{ id: "existing-read-attestation", action: "read" }];
    installMocks();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: "google-access-token",
          refresh_token: "google-refresh-token",
          expires_in: 3600,
          scope:
            "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events.owned",
          token_type: "Bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { GET } = await import("@/app/api/oauth/google/callback/route");
    const res = await GET(
      new Request(
        "https://comparative.example/api/oauth/google/callback?code=abc&state=state-123",
        { headers: { cookie: "google_oauth_state=state-123" } },
      ),
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://comparative.example/chat?connected=google",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/x-www-form-urlencoded",
        }),
        body: expect.any(URLSearchParams),
      }),
    );

    const { decryptSecret } = await import("@/lib/oauth/crypto");
    expect(capturedTokenValues).toMatchObject({
      userId: session.id,
      provider: "google",
      refreshToken: expect.any(String),
      scope: expect.stringContaining(
        "https://www.googleapis.com/auth/gmail.readonly",
      ),
    });
    expect(decryptSecret(String(capturedTokenValues?.accessToken))).toBe(
      "google-access-token",
    );
    expect(decryptSecret(String(capturedTokenValues?.refreshToken))).toBe(
      "google-refresh-token",
    );
    expect(capturedAttestationValues).toMatchObject({
      userId: session.id,
      scopeType: "provider",
      provider: "google",
      action: "write",
      metadata: { source: "google_oauth_callback" },
    });
  });

  it("does not duplicate a write approval when an older read approval also exists", async () => {
    selectRows = [
      { id: "existing-read-attestation", action: "read" },
      { id: "existing-write-attestation", action: "write" },
    ];
    installMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            access_token: "google-access-token",
            scope:
              "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events.owned",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const { GET } = await import("@/app/api/oauth/google/callback/route");
    await GET(
      new Request(
        "https://comparative.example/api/oauth/google/callback?code=abc&state=state-123",
        { headers: { cookie: "google_oauth_state=state-123" } },
      ),
    );

    expect(capturedAttestationValues).toBeUndefined();
  });

  it("fails closed when Google omits the authoritative granted-scope list", async () => {
    installMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            access_token: "google-access-token",
            refresh_token: "google-refresh-token",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const { GET } = await import("@/app/api/oauth/google/callback/route");
    const res = await GET(
      new Request(
        "https://comparative.example/api/oauth/google/callback?code=abc&state=state-123",
        { headers: { cookie: "google_oauth_state=state-123" } },
      ),
    );

    expect(res.status).toBe(302);
    expect(capturedTokenValues?.scope).toBeNull();
    expect(capturedAttestationValues).toMatchObject({ action: "write" });
  });

  it("redirects failed callbacks back to Tools with an actionable error", async () => {
    installMocks();
    const { GET } = await import("@/app/api/oauth/google/callback/route");
    const res = await GET(
      new Request(
        "https://comparative.example/api/oauth/google/callback?error=access_denied",
      ),
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://comparative.example/chat?connected=google&error=access_denied",
    );
    expect(capturedTokenValues).toBeUndefined();
  });
});
