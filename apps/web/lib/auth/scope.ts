import type { SessionUser, UserRole } from "@ai-workspace/auth";
import type { AnyColumn } from "drizzle-orm";
import { eq, type SQL } from "drizzle-orm";

/**
 * Predicate builder for per-user data scoping on read queries.
 *
 * - role = 'user'  → returns `column = sessionUser.id` (sees only own rows)
 * - role = 'admin' → returns undefined (no filter; sees everything)
 *
 * Use the result with drizzle's `and(...)`, which transparently drops
 * `undefined` clauses, so the same `where(and(scope, ...))` shape works for
 * both roles. Read-side only — write/destructive routes keep their explicit
 * ownership checks regardless of role.
 */
export function userScope(
  user: SessionUser | { role: UserRole; id: string },
  column: AnyColumn,
): SQL | undefined {
  return user.role === "admin" ? undefined : eq(column, user.id);
}
