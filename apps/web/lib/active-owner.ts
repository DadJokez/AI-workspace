import { users } from "@ai-workspace/db";
import { sql, type AnyColumn, type SQL } from "drizzle-orm";

/**
 * `EXISTS (an active user whose id is <ownerColumn>)`, for the background
 * lanes that act on a user's behalf without a request: the chat worker's run
 * claim and the scheduler's schedule claim. A suspended or deprovisioned
 * user's work is never picked up, even when it was enqueued in the instant
 * before the suspension committed (`lib/user-lifecycle.ts`).
 */
export function ownerIsActive(ownerColumn: AnyColumn): SQL {
  return sql`exists (select 1 from ${users} where ${users.id} = ${ownerColumn} and ${users.status} = 'active')`;
}
