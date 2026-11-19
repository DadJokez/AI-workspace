import type { SessionUser } from "@ai-workspace/auth";
import type { AnyColumn } from "drizzle-orm";
import { eq, type SQL } from "drizzle-orm";

/**
 * Predicate for per-user data scoping on read queries: `column = user.id`,
 * for every role. An admin's personal surfaces (thread list, thread detail,
 * export, run status, feedback attachments) show the admin's own rows, the
 * same as anyone else's.
 *
 * Reading another user's data is an admin feature in its own right and goes
 * through an explicit admin route that calls `requireAdmin`, takes a reason,
 * and writes an `admin.user_data_access` audit row before it returns anything
 * (`lib/admin-data-access.ts`, e.g. `/api/admin/runs/[id]/trace`).
 */
export function userScope(
  user: Pick<SessionUser, "id">,
  column: AnyColumn,
): SQL {
  return eq(column, user.id);
}
