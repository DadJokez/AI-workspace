import { afterEach, describe, expect, it, vi } from "vitest";

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

interface ReactElementLike {
  type?: unknown;
  props?: Record<string, unknown>;
}

/**
 * Walk the JSX tree returned from a server component (without rendering it)
 * and collect all string content. Server components compose by returning
 * React elements whose `type` is a function — we descend into props.children
 * and also concatenate any string-valued props (so `title`/`message` props
 * passed to ErrorPanel still contribute text).
 */
function collectText(node: unknown): string {
  if (node === null || node === undefined || node === false || node === true) {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join(" ");
  const el = node as ReactElementLike;
  if (typeof el !== "object" || !el.props) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(el.props)) {
    if (key === "children") {
      parts.push(collectText(value));
    } else if (typeof value === "string") {
      parts.push(value);
    }
  }
  return parts.join(" ");
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
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);
    const { default: InvitePage } = await import("@/app/invite/[token]/page");
    const tree = await InvitePage({
      params: Promise.resolve({ token: "used" }),
    });
    expect(collectText(tree)).toContain("Invitation already used");
  });

  it("renders the sign-in CTA for a valid pending invite", async () => {
    installDbMock([
      {
        email: "valid@example.com",
        role: "admin",
        acceptedAt: null,
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
    expect(text).toContain("Continue with GitHub");
    expect(text).toContain("valid@example.com");
    expect(text).toContain("admin");
  });
});
