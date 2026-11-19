/** Longest reason an admin may give for a privileged action. */
export const ADMIN_REASON_MAX_CHARS = 500;

/**
 * The reason an admin gives for suspending a user, reading another user's
 * data, and the like: a non-empty string of at most ADMIN_REASON_MAX_CHARS
 * after trimming. Returns null for anything else; a reason that is too long
 * is refused, not truncated, so the ledger never holds half a sentence.
 */
export function parseAdminReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const reason = value.trim();
  if (reason.length === 0 || reason.length > ADMIN_REASON_MAX_CHARS) {
    return null;
  }
  return reason;
}
