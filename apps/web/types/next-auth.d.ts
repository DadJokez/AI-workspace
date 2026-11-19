import type { UserRole } from "@ai-workspace/auth";
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      displayName: string;
      role: UserRole;
      /** `users.session_version` when the session's JWT was issued. */
      sessionVersion?: number;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    ghSub?: string;
    userId?: string;
    role?: UserRole;
    /**
     * `users.session_version` at sign-in. Never refreshed afterwards: a
     * suspension bumps the row, and `getSessionUser` refuses the mismatch.
     */
    sv?: number;
  }
}
