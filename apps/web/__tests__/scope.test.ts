import { describe, expect, it } from "vitest";
import { chatThreads } from "@ai-workspace/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { userScope } from "@/lib/auth/scope";

const userA = { id: "user-a-uuid", role: "user" as const };
const userB = { id: "user-b-uuid", role: "user" as const };
const admin = { id: "admin-uuid", role: "admin" as const };

const rendered = (predicate: ReturnType<typeof userScope>) =>
  new PgDialect().sqlToQuery(predicate);

describe("userScope", () => {
  it("scopes a user to their own rows", () => {
    expect(rendered(userScope(userA, chatThreads.userId))).toEqual(
      expect.objectContaining({
        sql: '"chat_threads"."user_id" = $1',
        params: ["user-a-uuid"],
      }),
    );
  });

  it("scopes an admin to their own rows too (WP-18: no admin bypass)", () => {
    expect(rendered(userScope(admin, chatThreads.userId))).toEqual(
      expect.objectContaining({
        sql: '"chat_threads"."user_id" = $1',
        params: ["admin-uuid"],
      }),
    );
  });

  it("scopes different users to different ids", () => {
    expect(rendered(userScope(userA, chatThreads.userId)).params).not.toEqual(
      rendered(userScope(userB, chatThreads.userId)).params,
    );
  });
});
