import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Dynamic imports below: the token module captures SALESFORCE_CLIENT_ID at
// import time, so env must be stubbed and modules reset before importing.
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("OAUTH_ENCRYPTION_KEY", Buffer.alloc(32, 6).toString("base64"));
  vi.stubEnv("SALESFORCE_CLIENT_ID", "client-id");
  vi.stubEnv("SALESFORCE_CLIENT_SECRET", "client-secret");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type TokenRow = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
  providerMetadata: unknown;
};

let updatedSet: Record<string, unknown> | null = null;

function makeDb(rows: TokenRow[]) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => rows }),
      }),
    }),
    update: () => ({
      set: (set: Record<string, unknown>) => {
        updatedSet = set;
        return { where: async () => undefined };
      },
    }),
  } as never;
}

const TRUSTED_URL = "https://org.my.salesforce.com";

async function baseRow(overrides: Partial<TokenRow> = {}): Promise<TokenRow> {
  const { encryptSecret } = await import("@/lib/oauth/crypto");
  return {
    accessToken: encryptSecret("stored-access"),
    refreshToken: encryptSecret("stored-refresh"),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    scope: "api refresh_token",
    providerMetadata: { instanceUrl: TRUSTED_URL },
    ...overrides,
  };
}

async function resolve(rows: TokenRow[]) {
  updatedSet = null;
  const { resolveSalesforceConnection } = await import(
    "@/lib/oauth/salesforce-token"
  );
  return resolveSalesforceConnection(makeDb(rows), "user-1");
}

describe("resolveSalesforceConnection", () => {
  it("returns not_connected when there is no row", async () => {
    const state = await resolve([]);
    expect(state.status).toBe("not_connected");
  });

  it("is ready on a fresh token without refreshing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const state = await resolve([await baseRow()]);
    expect(state).toMatchObject({
      status: "ready",
      instanceUrl: TRUSTED_URL,
      accessToken: "stored-access",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires reconnect when the api scope is missing", async () => {
    const state = await resolve([await baseRow({ scope: "refresh_token" })]);
    expect(state).toMatchObject({
      status: "reconnect_required",
      reason: "insufficient_scope",
    });
  });

  it("requires reconnect when the stored instance host is untrusted", async () => {
    const state = await resolve([
      await baseRow({ providerMetadata: { instanceUrl: "https://evil.example" } }),
    ]);
    expect(state).toMatchObject({
      status: "reconnect_required",
      reason: "missing_instance_url",
    });
  });

  it("refreshes an expired token and persists the new access token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          access_token: "fresh-access",
          instance_url: TRUSTED_URL,
        }),
      })),
    );
    const state = await resolve([
      await baseRow({ expiresAt: new Date(Date.now() - 1000) }),
    ]);
    expect(state).toMatchObject({ status: "ready", accessToken: "fresh-access" });
    expect(updatedSet).not.toBeNull();
  });

  it("maps invalid_grant on refresh to an expired-grant reconnect", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ error: "invalid_grant" }),
      })),
    );
    const state = await resolve([
      await baseRow({ expiresAt: new Date(Date.now() - 1000) }),
    ]);
    expect(state).toMatchObject({
      status: "reconnect_required",
      reason: "expired_grant",
    });
  });

  it("treats a refresh 5xx as temporarily unavailable, not disconnected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    const state = await resolve([
      await baseRow({ expiresAt: new Date(Date.now() - 1000) }),
    ]);
    expect(state).toMatchObject({
      status: "temporarily_unavailable",
      reason: "token_refresh_failed",
    });
  });

  it("ignores an untrusted instance_url from a refresh, keeping the stored one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          access_token: "fresh-access",
          instance_url: "https://evil.example",
        }),
      })),
    );
    const state = await resolve([
      await baseRow({ expiresAt: new Date(Date.now() - 1000) }),
    ]);
    expect(state).toMatchObject({ status: "ready", instanceUrl: TRUSTED_URL });
  });
});
