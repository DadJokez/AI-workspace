import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@ai-workspace/auth";

const session: SessionUser = {
  id: "00000000-0000-4000-8000-000000000259",
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

    const mockDb: Record<string, unknown> = {
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
        insertQuery.onConflictDoUpdate = () => insertQuery;
        insertQuery.returning = async () =>
          table === actual.oauthTokens
            ? [{ id: "notion-connection" }]
            : [{ id: "notion-attestation" }];
        insertQuery.then = (resolve: (value: unknown) => void) => resolve([]);
        return insertQuery;
      },
    };
    mockDb.transaction = async (
      callback: (tx: Record<string, unknown>) => Promise<unknown>,
    ) => callback(mockDb);

    return {
      ...actual,
      getDb: () => mockDb as never,
    };
  });
}

beforeEach(() => {
  currentSession = session;
  selectRows = [];
  capturedTokenValues = undefined;
  capturedAttestationValues = undefined;
  vi.stubEnv("NEXTAUTH_URL", "https://comparative.example");
  vi.stubEnv("NOTION_CLIENT_ID", "notion-client-id");
  vi.stubEnv("NOTION_CLIENT_SECRET", "notion-client-secret");
  vi.stubEnv(
    "OAUTH_ENCRYPTION_KEY",
    Buffer.alloc(32, 7).toString("base64"),
  );
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Notion OAuth routes", () => {
  it("redirects authenticated users to Notion authorize with a state cookie", async () => {
    installMocks();
    const { GET } = await import("@/app/api/oauth/notion/start/route");

    const res = await GET();
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    const url = new URL(location!);
    expect(url.origin + url.pathname).toBe(
      "https://api.notion.com/v1/oauth/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("notion-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://comparative.example/api/oauth/notion/callback",
    );
    expect(url.searchParams.get("owner")).toBe("user");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(res.headers.get("set-cookie")).toContain("notion_oauth_state=");
  });

  it("stores encrypted Notion tokens and creates a provider attestation", async () => {
    installMocks();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: "notion-access-token",
          refresh_token: "notion-refresh-token",
          expires_in: 3600,
          bot_id: "bot-123",
          workspace_id: "workspace-123",
          workspace_name: "Robot HQ",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { GET } = await import("@/app/api/oauth/notion/callback/route");
    const res = await GET(
      new Request(
        "https://comparative.example/api/oauth/notion/callback?code=abc&state=state-123",
        { headers: { cookie: "notion_oauth_state=state-123" } },
      ),
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://comparative.example/chat?connected=notion",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.notion.com/v1/oauth/token",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from(
            "notion-client-id:notion-client-secret",
          ).toString("base64")}`,
          "Content-Type": "application/json",
        }),
      }),
    );

    const { decryptSecret } = await import("@/lib/oauth/crypto");
    expect(capturedTokenValues).toMatchObject({
      userId: session.id,
      provider: "notion",
      refreshToken: expect.any(String),
      scope: expect.stringContaining("workspace:workspace-123"),
    });
    expect(decryptSecret(String(capturedTokenValues?.accessToken))).toBe(
      "notion-access-token",
    );
    expect(decryptSecret(String(capturedTokenValues?.refreshToken))).toBe(
      "notion-refresh-token",
    );
    expect(capturedAttestationValues).toMatchObject({
      userId: session.id,
      scopeType: "provider",
      provider: "notion",
      action: "admin",
      metadata: { source: "notion_oauth_callback" },
    });
  });

  it("redirects failed callbacks back to Tools with an actionable error", async () => {
    installMocks();
    const { GET } = await import("@/app/api/oauth/notion/callback/route");
    const res = await GET(
      new Request(
        "https://comparative.example/api/oauth/notion/callback?error=access_denied",
      ),
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://comparative.example/chat?connected=notion&error=access_denied",
    );
    expect(capturedTokenValues).toBeUndefined();
  });
});
