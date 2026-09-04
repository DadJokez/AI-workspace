import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectText,
  type ReactElementLike,
} from "./helpers/collect-text";

/**
 * Tests for the /invite/[token] server component. We mock @ai-workspace/db
 * so we can drive the lookup through the four states (not_found, accepted,
 * expired, ok) and assert the rendered JSX tree contains the expected
 * heading text.
 */

interface InviteRow {
  email: string;
  role: "admin" | "user";
  acceptedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
}

function installDbMock(rows: InviteRow[]) {
  vi.doMock("@ai-workspace/db", async () => {
    const actual =
      await vi.importActual<typeof import("@ai-workspace/db")>(
        "@ai-workspace/db",
      );

    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "limit") {
            return () => Promise.resolve(rows);
          }
          return () => proxy;
        },
      },
    );

    return {
      ...actual,
      getDb: () => proxy as never,
    };
  });
}

function collectHrefs(node: unknown): string[] {
  if (node === null || node === undefined || typeof node !== "object") {
    return [];
  }
  if (Array.isArray(node)) return node.flatMap(collectHrefs);
  const el = node as ReactElementLike;
  if (!el.props) return [];
  return [
    ...(typeof el.props.href === "string" ? [el.props.href] : []),
    ...collectHrefs(el.props.children),
  ];
}

afterEach(() => {
  vi.resetModules();
});

describe("/invite/[token] page", () => {
  it("renders 'not found' when the token doesn't match any row", async () => {
    installDbMock([]);
    const { default: InvitePage } = await import("@/app/invite/[token]/page");
    const tree = await InvitePage({
      params: Promise.resolve({ token: "missing" }),
    });
    expect(collectText(tree)).toContain("Invitation not found");
  });

  it("renders 'expired' when expiresAt is in the past", async () => {
    installDbMock([
      {
        email: "a@example.com",
        role: "user",
        acceptedAt: null,
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1000),
      },
    ]);
    const { default: InvitePage } = await import("@/app/invite/[token]/page");
    const tree = await InvitePage({
      params: Promise.resolve({ token: "old" }),
    });
    expect(collectText(tree)).toContain("Invitation expired");
  });

  it("renders 'already used' when acceptedAt is set", async () => {
    installDbMock([
      {
        email: "a@example.com",
        role: "user",
        acceptedAt: new Date(),
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);
    const { default: InvitePage } = await import("@/app/invite/[token]/page");
    const tree = await InvitePage({
      params: Promise.resolve({ token: "used" }),
    });
    expect(collectText(tree)).toContain("Invitation already used");
  });

  it("renders 'revoked' when revokedAt is set", async () => {
    installDbMock([
      {
        email: "a@example.com",
        role: "user",
        acceptedAt: null,
        revokedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);
    const { default: InvitePage } = await import("@/app/invite/[token]/page");
    const tree = await InvitePage({
      params: Promise.resolve({ token: "revoked" }),
    });
    expect(collectText(tree)).toContain("Invitation revoked");
  });

  it("renders the sign-in CTA for a valid pending invite", async () => {
    installDbMock([
      {
        email: "valid@example.com",
        role: "admin",
        acceptedAt: null,
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);
    const { default: InvitePage } = await import("@/app/invite/[token]/page");
    const tree = await InvitePage({
      params: Promise.resolve({ token: "good" }),
    });
    const text = collectText(tree);
    expect(text).toContain("You");
    expect(text).toContain("invited");
    expect(text).toContain("Continue to sign in");
    expect(text).not.toContain("GitHub");
    expect(text).toContain("valid@example.com");
    expect(text).toContain("admin");
    expect(collectHrefs(tree)).toContain("/login?callbackUrl=%2Fchat");
  });
});
