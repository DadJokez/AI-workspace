import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * DB-free invariants of the minimal NextAuth adapter
 * (apps/web/lib/auth/nextauth-adapter.ts). The verification-token
 * create/use/expire/single-use roundtrip runs against real Postgres in
 * __integration__/nextauth-adapter.integration.test.ts.
 */

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

async function loadAdapter(overrides?: {
  ensureUser?: (input: unknown) => Promise<unknown>;
}) {
  vi.doMock("@ai-workspace/db", async () => {
    const actual =
      await vi.importActual<typeof import("@ai-workspace/db")>(
        "@ai-workspace/db",
      );
    return {
      ...actual,
      getDb: () => {
        throw new Error("unexpected DB access in DB-free adapter test");
      },
    };
  });
  vi.doMock("@/lib/users", async () => {
    const actual =
      await vi.importActual<typeof import("@/lib/users")>("@/lib/users");
    return {
      ...actual,
      ensureUser:
        overrides?.ensureUser ??
        (async () => {
          throw new Error("ensureUser not stubbed for this test");
        }),
    };
  });
  const { createNextAuthAdapter, emailPingSubject } = await import(
    "@/lib/auth/nextauth-adapter"
  );
  return { adapter: createNextAuthAdapter(), emailPingSubject };
}

describe("nextauth adapter — DB-free invariants", () => {
  it("getUser short-circuits non-uuid ids (legacy JWT subs carry GitHub ids) without touching the DB", async () => {
    const { adapter } = await loadAdapter();
    // Pre-adapter GitHub tokens: sub = numeric GitHub id. e2e-minted tokens:
    // sub = arbitrary string. Neither may reach Postgres as a uuid literal.
    await expect(adapter.getUser?.("8234901")).resolves.toBeNull();
    await expect(
      adapter.getUser?.("auth-smoke-github-subject"),
    ).resolves.toBeNull();
    await expect(
      adapter.getUser?.("tester@example.com"),
    ).resolves.toBeNull();
  });

  it("createUser delegates to ensureUser with the email-derived subject and email fallback display name", async () => {
    const ensureUser = vi.fn(async () => ({
      id: "11111111-2222-4333-8444-555555555555",
      pingSubject: "email:tester@example.com",
      email: "tester@example.com",
      displayName: "tester@example.com",
      role: "user",
    }));
    const { adapter } = await loadAdapter({ ensureUser });

    const created = await adapter.createUser?.({
      email: "tester@example.com",
      emailVerified: new Date(),
    });

    expect(ensureUser).toHaveBeenCalledWith({
      id: "email:tester@example.com",
      email: "tester@example.com",
      displayName: "tester@example.com",
    });
    expect(created).toMatchObject({
      id: "11111111-2222-4333-8444-555555555555",
      email: "tester@example.com",
      emailVerified: null,
    });
  });

  it("createUser keeps the IdP display name when one is provided (GitHub-created users)", async () => {
    const ensureUser = vi.fn(async (input: unknown) => ({
      id: "11111111-2222-4333-8444-555555555555",
      pingSubject: (input as { id: string }).id,
      email: "tester@example.com",
      displayName: "Tester Person",
      role: "user",
    }));
    const { adapter } = await loadAdapter({ ensureUser });

    await adapter.createUser?.({
      email: "tester@example.com",
      name: "Tester Person",
      emailVerified: null,
    });

    expect(ensureUser).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "Tester Person" }),
    );
  });

  it("createUser refuses a userless email", async () => {
    const { adapter } = await loadAdapter();
    await expect(
      adapter.createUser?.({ email: "", emailVerified: null }),
    ).rejects.toThrow(/without an email/);
  });

  it("normalizes the email-derived ping subject", async () => {
    const { emailPingSubject } = await loadAdapter();
    expect(emailPingSubject("  Tester@Example.COM ")).toBe(
      "email:tester@example.com",
    );
  });

  it("useVerificationToken refuses blank inputs without touching the DB", async () => {
    const { adapter } = await loadAdapter();
    await expect(
      adapter.useVerificationToken?.({ identifier: "", token: "abc" }),
    ).resolves.toBeNull();
    await expect(
      adapter.useVerificationToken?.({
        identifier: "tester@example.com",
        token: "",
      }),
    ).resolves.toBeNull();
  });

  it("stub-throws the DB-session and destructive methods with clear messages", async () => {
    const { adapter } = await loadAdapter();
    await expect(adapter.createSession?.({} as never)).rejects.toThrow(
      /cookie-JWT/,
    );
    await expect(adapter.getSessionAndUser?.("t")).rejects.toThrow(
      /cookie-JWT/,
    );
    await expect(adapter.updateSession?.({} as never)).rejects.toThrow(
      /cookie-JWT/,
    );
    await expect(adapter.deleteSession?.("t")).rejects.toThrow(/cookie-JWT/);
    await expect(adapter.deleteUser?.("u")).rejects.toThrow(/deleteUser/);
    await expect(adapter.unlinkAccount?.({} as never)).rejects.toThrow(
      /unlinkAccount/,
    );
  });
});
