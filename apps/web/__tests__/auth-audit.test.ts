import { describe, expect, it, vi } from "vitest";
import {
  AUTH_AUDIT_USER_AGENT_MAX,
  authRequestContext,
  authRequestContextFrom,
  buildAuthAuditRow,
  clientIpFromForwardedFor,
  recordAuthEvent,
} from "@/lib/auth/auth-audit";

/**
 * Row shape and request-context extraction for authentication audit events
 * (`lib/auth/auth-audit.ts`). Wiring into next-auth is covered by
 * nextauth-auth-events.test.ts.
 */

describe("clientIpFromForwardedFor", () => {
  it("takes the rightmost hop — the one our own ALB appended", () => {
    // A client can prepend anything, so the leftmost entry is hostile.
    expect(clientIpFromForwardedFor("1.1.1.1, 203.0.113.7")).toBe("203.0.113.7");
    expect(clientIpFromForwardedFor("203.0.113.7")).toBe("203.0.113.7");
  });

  it("returns null when there is no forwarded-for header", () => {
    expect(clientIpFromForwardedFor(null)).toBeNull();
    expect(clientIpFromForwardedFor("  ")).toBeNull();
  });
});

describe("authRequestContextFrom", () => {
  it("keeps only ip and user-agent", () => {
    const headers = new Headers({
      "x-forwarded-for": "1.1.1.1, 203.0.113.7",
      "user-agent": "Mozilla/5.0 (Macintosh)",
      cookie: "next-auth.session-token=super-secret-jwt",
      authorization: "Bearer super-secret-token",
    });

    expect(authRequestContextFrom(headers)).toEqual({
      ip: "203.0.113.7",
      userAgent: "Mozilla/5.0 (Macintosh)",
    });
  });

  it("truncates absurd user-agent strings", () => {
    const headers = new Headers({ "user-agent": "u".repeat(5_000) });
    expect(authRequestContextFrom(headers).userAgent).toHaveLength(
      AUTH_AUDIT_USER_AGENT_MAX,
    );
  });
});

describe("authRequestContext", () => {
  it("degrades to nulls outside a request scope instead of throwing", async () => {
    await expect(authRequestContext()).resolves.toEqual({
      ip: null,
      userAgent: null,
    });
  });
});

describe("buildAuthAuditRow", () => {
  it("records a successful sign-in against the DB user id", () => {
    expect(
      buildAuthAuditRow({
        action: "auth_sign_in",
        actorUserId: "11111111-1111-4111-8111-111111111111",
        authProvider: "github",
        isNewUser: false,
        request: { ip: "203.0.113.7", userAgent: "Mozilla/5.0" },
      }),
    ).toEqual({
      actorUserId: "11111111-1111-4111-8111-111111111111",
      actionType: "auth_sign_in",
      status: "succeeded",
      provider: "ai-hub",
      toolName: "auth",
      input: null,
      error: null,
      metadata: {
        schema: "auth-event.v1",
        authProvider: "github",
        isNewUser: false,
        ip: "203.0.113.7",
        userAgent: "Mozilla/5.0",
      },
    });
  });

  it("records a denial with the attempted address, phase and reason", () => {
    expect(
      buildAuthAuditRow({
        action: "auth_sign_in_denied",
        authProvider: "email",
        email: "  Stranger@Example.COM ",
        reason: "not_invited",
        phase: "link_request",
      }),
    ).toEqual({
      actorUserId: null,
      actionType: "auth_sign_in_denied",
      status: "denied",
      provider: "ai-hub",
      toolName: "auth",
      input: { email: "stranger@example.com" },
      error: "not_invited",
      metadata: {
        schema: "auth-event.v1",
        authProvider: "email",
        phase: "link_request",
      },
    });
  });

  it("records a sign-out with no identity beyond the user id", () => {
    const row = buildAuthAuditRow({
      action: "auth_sign_out",
      actorUserId: "22222222-2222-4222-8222-222222222222",
      request: { ip: null, userAgent: null },
    });

    expect(row.actionType).toBe("auth_sign_out");
    expect(row.status).toBe("succeeded");
    expect(row.input).toBeNull();
    expect(row.metadata).toEqual({ schema: "auth-event.v1" });
  });
});

describe("recordAuthEvent", () => {
  it("appends the built row", async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    const db = { insert: vi.fn(() => ({ values })) };

    await recordAuthEvent(
      { action: "auth_sign_in", actorUserId: "user-1" },
      db as never,
    );

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: "auth_sign_in" }),
    );
  });

  it("fails open, and logs the message only — never the driver error", async () => {
    const error = new Error("connection refused");
    const db = {
      insert: () => ({
        values: () => Promise.reject(error),
      }),
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      recordAuthEvent({ action: "auth_sign_in" }, db as never),
    ).resolves.toBeUndefined();

    expect(spy).toHaveBeenCalledWith(
      "[auth-audit] failed to record auth_sign_in: connection refused",
    );
    // The raw error object can echo row values in some drivers.
    expect(spy.mock.calls[0]).toHaveLength(1);
    spy.mockRestore();
  });
});
