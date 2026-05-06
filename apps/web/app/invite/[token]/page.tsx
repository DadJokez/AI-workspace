import Link from "next/link";
import { lookupInvitationByToken } from "@/lib/invitations";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ token: string }>;
}

/**
 * Invite acceptance page. The admin shares `/invite/<token>` out-of-band;
 * the invitee lands here, sees who they were invited as, and clicks
 * "Sign in with GitHub" to enter the workspace. The actual role assignment
 * happens in `ensureUser` when their account is upserted on first sign-in
 * (matched by email), so this page is purely a validation + UX surface.
 */
export default async function InvitePage({ params }: PageProps) {
  const { token } = await params;
  const result = await lookupInvitationByToken(token);

  if (result.status !== "valid") {
    const { title, body } = errorCopyFor(result.status);
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-ink">{title}</h1>
        <p className="mt-2 text-[13px] text-muted">{body}</p>
        <p className="mt-6 text-[12px] text-muted">
          Ask your workspace admin for a fresh invite link.
        </p>
      </Shell>
    );
  }

  const invite = result.invitation!;
  // The eventual NextAuth GitHub provider lives at `/api/auth/signin/github`.
  // We round-trip the invite token through `callbackUrl` so a follow-up PR
  // can attribute the sign-in if it needs to (today, `ensureUser` matches
  // by email and the token is informational).
  const callbackUrl = `/chat?invite=${encodeURIComponent(token)}`;
  const signInHref = `/api/auth/signin/github?callbackUrl=${encodeURIComponent(
    callbackUrl,
  )}`;

  return (
    <Shell>
      <h1 className="text-lg font-semibold text-ink">
        You&rsquo;ve been invited to AI Workspace
      </h1>
      <p className="mt-2 text-[13px] text-muted">
        Sign in with the GitHub account tied to{" "}
        <span className="font-medium text-ink">{invite.email}</span> to join as
        a <RoleBadge role={invite.role} />.
      </p>
      <Link
        href={signInHref}
        className="mt-6 inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-[13px] font-medium text-canvas hover:opacity-90"
      >
        <GithubMark />
        Sign in with GitHub
      </Link>
      <p className="mt-6 text-[11px] text-muted">
        This invite expires {invite.expiresAt.toLocaleString()}.
      </p>
    </Shell>
  );
}

function errorCopyFor(
  status: "expired" | "accepted" | "not_found",
): { title: string; body: string } {
  switch (status) {
    case "expired":
      return {
        title: "This invite has expired",
        body: "The link you used is past its 7-day expiration window.",
      };
    case "accepted":
      return {
        title: "This invite has already been used",
        body: "Each invite link can only be redeemed once.",
      };
    case "not_found":
      return {
        title: "Invite not found",
        body: "We couldn't find an invitation matching this link. It may have been revoked or the URL was mistyped.",
      };
  }
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-md rounded-lg border border-hairline bg-canvas p-6 shadow-sm">
        {children}
      </div>
    </main>
  );
}

function RoleBadge({ role }: { role: "admin" | "user" }) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] uppercase tracking-wider ${
        role === "admin"
          ? "bg-accent/15 text-accent"
          : "bg-subtle text-muted"
      }`}
    >
      {role}
    </span>
  );
}

function GithubMark() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden
    >
      <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}
