import { getDb, invitations } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { ThemeToggle } from "@/components/ThemeToggle";

export const dynamic = "force-dynamic";

interface InviteLookup {
  status: "ok" | "not_found" | "expired" | "accepted" | "revoked";
  email?: string;
  role?: "admin" | "user";
}

async function lookupInvitation(token: string): Promise<InviteLookup> {
  const db = getDb();
  const rows = await db
    .select({
      email: invitations.email,
      role: invitations.role,
      acceptedAt: invitations.acceptedAt,
      revokedAt: invitations.revokedAt,
      expiresAt: invitations.expiresAt,
    })
    .from(invitations)
    .where(eq(invitations.token, token))
    .limit(1);

  const row = rows[0];
  if (!row) return { status: "not_found" };
  if (row.acceptedAt !== null) return { status: "accepted" };
  if (row.revokedAt !== null) return { status: "revoked" };
  if (row.expiresAt.getTime() <= Date.now()) return { status: "expired" };
  return { status: "ok", email: row.email, role: row.role };
}

function ErrorPanel({ title, message }: { title: string; message: string }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center bg-canvas px-6 text-ink">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-md rounded-lg border border-hairline bg-subtle/30 p-8 text-center">
        <h1 className="text-base font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-muted">{message}</p>
        <p className="mt-6 text-xs text-muted">
          Ask the admin who invited you for a fresh link.
        </p>
      </div>
    </div>
  );
}

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const result = await lookupInvitation(token);

  if (result.status === "not_found") {
    return (
      <ErrorPanel
        title="Invitation not found"
        message="This invite link doesn't match any pending invitation."
      />
    );
  }
  if (result.status === "expired") {
    return (
      <ErrorPanel
        title="Invitation expired"
        message="This invite link is older than 7 days and can no longer be used."
      />
    );
  }
  if (result.status === "accepted") {
    return (
      <ErrorPanel
        title="Invitation already used"
        message="This invite link has already been redeemed."
      />
    );
  }
  if (result.status === "revoked") {
    return (
      <ErrorPanel
        title="Invitation revoked"
        message="This invite link was revoked by an admin."
      />
    );
  }

  const signInHref = `/api/auth/signin/github?callbackUrl=${encodeURIComponent(
    "/chat",
  )}`;

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-canvas px-6 text-ink">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-md rounded-lg border border-hairline bg-subtle/30 p-8 text-center">
        <h1 className="text-base font-semibold">You&apos;ve been invited</h1>
        <p className="mt-2 text-sm text-muted">
          Sign in with GitHub to join the workspace as{" "}
          <span className="text-ink">{result.email}</span>.
        </p>
        <p className="mt-1 text-xs text-muted">
          You will be granted the{" "}
          <span className="text-ink">{result.role}</span> role.
        </p>
        <Link
          href={signInHref}
          className="mt-6 inline-flex items-center justify-center rounded-md bg-ink px-4 py-2 text-sm font-medium text-canvas hover:opacity-90"
        >
          Continue with GitHub
        </Link>
      </div>
    </div>
  );
}
