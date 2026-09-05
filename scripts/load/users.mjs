/**
 * Synthetic load-test identities (#696).
 *
 * Shared by `apps/web/scripts/seed-load-users.ts` (writes the rows) and
 * `scripts/load/pilot-load.mjs` (mints a session for each row), so both sides
 * agree on ids without a lookup. The chat rate limiter is a per-user fixed
 * window (30 requests / 60 s, `apps/web/lib/request-limits.ts`), so a
 * realistic concurrent-chat measurement needs many distinct users — the
 * pilot row in docs/ENTERPRISE_READINESS.md is 1k users.
 *
 * Ids are valid v4-shaped UUIDs in a reserved block (`…-00000ad0XXXX`) so
 * they can never collide with real `gen_random_uuid()` rows in practice and
 * are recognisable in any table.
 */

export const LOAD_USER_SUBJECT_PREFIX = "load-user-";

/** @param {number} index zero-based, < 65536 */
export function loadUser(index) {
  if (!Number.isInteger(index) || index < 0 || index > 0xffff) {
    throw new RangeError(`load user index out of range: ${index}`);
  }
  const suffix = index.toString(16).padStart(4, "0");
  return {
    id: `00000000-0000-4000-8000-00000ad0${suffix}`,
    pingSubject: `${LOAD_USER_SUBJECT_PREFIX}${index}`,
    email: `${LOAD_USER_SUBJECT_PREFIX}${index}@load.invalid`,
    displayName: `Load User ${index}`,
    role: "user",
  };
}
