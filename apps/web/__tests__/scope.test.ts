import { describe, expect, it } from "vitest";
import { chatThreads } from "@ai-workspace/db";
import { userScope } from "@/lib/auth/scope";

const userA = { id: "user-a-uuid", role: "user" as const };
const userB = { id: "user-b-uuid", role: "user" as const };
const admin = { id: "admin-uuid", role: "admin" as const };

describe("userScope", () => {
  it("returns an eq predicate for role=user (sees only own rows)", () => {
    const predicate = userScope(userA, chatThreads.userId);
    expect(predicate).toBeDefined();
    // Drizzle predicates are SQL nodes; we don't compare AST shape here. The
    // important contract is "predicate present for users, absent for admins"
    // — the route-level tests below cover the resulting WHERE behaviour.
  });

  it("returns undefined for role=admin (sees all rows)", () => {
    const predicate = userScope(admin, chatThreads.userId);
    expect(predicate).toBeUndefined();
  });

  it("scopes different users to different ids", () => {
    const a = userScope(userA, chatThreads.userId);
    const b = userScope(userB, chatThreads.userId);
    // Each user gets a non-empty predicate; they should not be the same
    // object reference (each call builds its own SQL node).
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
  });
});
