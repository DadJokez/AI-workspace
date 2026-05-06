/**
 * Thrown by `requireUser()` when the request has no authenticated user.
 * API route handlers translate it to a 401 response.
 */
export class UnauthorizedError extends Error {
  override readonly name = "UnauthorizedError";
  constructor(message = "Unauthorized") {
    super(message);
  }
}

/**
 * Thrown when the auth layer itself is misconfigured (e.g. missing OAuth
 * env vars in a deployment). This is a deploy bug, not an auth failure —
 * surfacing it as 500 not 401. Retained for callers that still catch it
 * even though NextAuth handles most config errors itself.
 */
export class AuthConfigError extends Error {
  override readonly name = "AuthConfigError";
  constructor(message: string) {
    super(message);
  }
}
