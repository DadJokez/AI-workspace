/**
 * Seed (or remove) the synthetic users `scripts/load/pilot-load.mjs` drives
 * (#696). The chat limiter is 30 requests / 60 s per user, so a 25-concurrent
 * chat measurement needs a pool of distinct users to rotate through.
 *
 *   DATABASE_URL=... pnpm --filter @ai-workspace/web seed:load-users            # 1000 users
 *   LOAD_USERS=200 DATABASE_URL=... pnpm --filter @ai-workspace/web seed:load-users
 *   DATABASE_URL=... pnpm --filter @ai-workspace/web seed:load-users -- --clean  # remove them
 *
 * Idempotent: every run first deletes existing load users (the FK cascades
 * take their threads, messages and runs with them; audit rows keep a null
 * actor) and their chat rate-limit buckets, then re-inserts unless --clean.
 * Users are inserted with role "user" explicitly so a fresh database never
 * hands the first-user-becomes-admin promotion to a synthetic account.
 */
import { closeDb, getDb, rateLimitBuckets, users } from "@ai-workspace/db";
import { inArray, like } from "drizzle-orm";
import {
  LOAD_USER_SUBJECT_PREFIX,
  loadUser,
} from "../../../scripts/load/users.mjs";

const clean = process.argv.includes("--clean");
const count = Number.parseInt(process.env.LOAD_USERS ?? "1000", 10);
if (!Number.isInteger(count) || count < 1 || count > 0xffff) {
  console.error(`LOAD_USERS must be an integer in 1..65535, got ${process.env.LOAD_USERS}`);
  process.exit(1);
}

async function main() {
  const db = getDb();
  const pattern = `${LOAD_USER_SUBJECT_PREFIX}%`;

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(like(users.pingSubject, pattern));
  if (existing.length > 0) {
    await db.delete(rateLimitBuckets).where(
      inArray(
        rateLimitBuckets.bucketKey,
        existing.map((u) => `chat:${u.id}`),
      ),
    );
    await db.delete(users).where(like(users.pingSubject, pattern));
  }
  if (clean) {
    console.log(`removed ${existing.length} load users`);
    return;
  }

  const rows = Array.from({ length: count }, (_, i) => ({
    ...loadUser(i),
    // Narrow the .mjs helper's `string` to the enum; never "admin".
    role: "user" as const,
    tourCompletedAt: new Date(),
  }));
  const chunk = 500;
  for (let i = 0; i < rows.length; i += chunk) {
    await db.insert(users).values(rows.slice(i, i + chunk));
  }
  console.log(
    `seeded ${count} load users (${loadUser(0).pingSubject} … ${loadUser(count - 1).pingSubject}), replacing ${existing.length}`,
  );
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err);
    await closeDb();
    process.exit(1);
  });
