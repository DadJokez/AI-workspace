import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

/**
 * WP-18: the JWT alone never authorizes. `getSessionUser` re-reads the user
 * row and honours the session only while the user is active and the token's
 * `sv` equals `users.session_version`; `last_seen_at` is bumped by a
 * conditional UPDATE that matches at most once per window. The write-once
 * behaviour against a real clock is pinned in
 * `__integration__/user-lifecycle.integration.test.ts`.
 */

const USER_ID = "00000000-0000-4000-8000-000000000018";

let session: { user: { id: string; sessionVersion?: number } } | null;
let row: Record<string, unknown> | undefined;
let updateWheres: SQL[];
let updateSets: Array<Record<string, unknown>>;

vi.mock("next-auth", () => ({
  getServerSession: async () => session,
}));
vi.mock("@/lib/auth/nextauth", () => ({ authOptions: {} }));
vi.mock("@ai-workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@ai-workspace/db")>(
      "@ai-workspace/db",
    );
  const select = () => ({
    from: () => ({
      where: () => ({ limit: async () => (row ? [row] : []) }),
    }),
  });
  const update = () => ({
    set: (values: Record<string, unknown>) => ({
      where: async (condition: SQL) => {
        updateSets.push(values);
        updateWheres.push(condition);
      },
    }),
  });
  return { ...actual, getDb: () => ({ select, update }) };
});

import {
  getSessionUser,
  sessionIsCurrent,
} from "@/lib/auth/getSessionUser";

function activeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    email: "ada@example.com",
    displayName: "Ada",
    role: "user",
    status: "active",
    sessionVersion: 2,
    ...overrides,
  };
}

beforeEach(() => {
  session = { user: { id: USER_ID, sessionVersion: 2 } };
  row = activeRow();
  updateWheres = [];
  updateSets = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("getSessionUser", () => {
  it("returns the row for an active user whose token carries the current session version", async () => {
    await expect(getSessionUser()).resolves.toEqual({
      id: USER_ID,
      email: "ada@example.com",
      displayName: "Ada",
      role: "user",
    });
  });

  it.each(["suspended", "deprovisioned"])(
    "refuses a %s user whose JWT is still valid and current",
    async (status) => {
      row = activeRow({ status });
      await expect(getSessionUser()).resolves.toBeNull();
      // A refused session leaves no trace on the row.
      expect(updateSets).toHaveLength(0);
    },
  );

  it("refuses a token issued before the session version was bumped", async () => {
    row = activeRow({ sessionVersion: 3 });
    await expect(getSessionUser()).resolves.toBeNull();
  });

  it("refuses a token with no session version (issued before WP-18)", async () => {
    session = { user: { id: USER_ID } };
    row = activeRow({ sessionVersion: 0 });
    await expect(getSessionUser()).resolves.toBeNull();
  });

  it("refuses when there is no session or the row is gone", async () => {
    session = null;
    await expect(getSessionUser()).resolves.toBeNull();
    session = { user: { id: USER_ID, sessionVersion: 2 } };
    row = undefined;
    await expect(getSessionUser()).resolves.toBeNull();
  });

  it("bumps last_seen_at only when the stored value is older than five minutes", async () => {
    await getSessionUser();

    expect(updateSets).toHaveLength(1);
    const { sql, params } = new PgDialect().sqlToQuery(updateWheres[0]!);
    expect(sql).toBe(
      `("users"."id" = $1 and "users"."last_seen_at" < now() - interval '5 minutes')`,
    );
    expect(params).toEqual([USER_ID]);
  });
});

describe("sessionIsCurrent", () => {
  it("needs both an active status and a matching version", () => {
    expect(sessionIsCurrent({ status: "active", sessionVersion: 0 }, 0)).toBe(
      true,
    );
    expect(sessionIsCurrent({ status: "active", sessionVersion: 1 }, 0)).toBe(
      false,
    );
    expect(
      sessionIsCurrent({ status: "suspended", sessionVersion: 0 }, 0),
    ).toBe(false);
    expect(sessionIsCurrent({ status: "active", sessionVersion: 0 }, "0")).toBe(
      false,
    );
  });
});
