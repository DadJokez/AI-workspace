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
 * Thrown when the auth shim itself is misconfigured (e.g. week-1 env vars
 * missing in a deployment). This is a deploy bug, not an auth failure —
 * surfacing it as 500 not 401.
 */
export class AuthConfigError extends Error {
  override readonly name = "AuthConfigError";
  constructor(message: string) {
    super(message);
  }
}
