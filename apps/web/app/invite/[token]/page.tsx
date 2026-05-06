import Link from "next/link";
import { lookupInvitation } from "@/lib/invitations";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ token: string }>;
}

function ErrorCard({
  title,
  body,
}: {
  title: string;
  body: string;
}) {
  return (
    <div className="mx-auto max-w-md rounded-lg border border-hairline bg-surface px-6 py-8 text-center">
      <h1 className="text-base font-semibold text-ink">{title}</h1>
      <p className="mt-2 text-[13px] text-muted">{body}</p>
      <Link
        href="/chat"
        className="mt-6 inline-block text-[13px] text-muted hover:text-ink"
      >
        Go to AI Hub →
      </Link>
    </div>
  );
}

function GithubMark() {
  // Inline SVG so we don't pull a new dep just for one icon.
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export default async function InvitePage({ params }: PageProps) {
  const { token } = await params;
  const result = await lookupInvitation(token);

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10 text-ink">
      {(() => {
        if (result.status === "not_found") {
          return (
            <ErrorCard
              title="Invitation not found"
              body="This link is invalid or has been revoked. Ask an admin for a new invite."
            />
          );
        }
        if (result.status === "expired") {
          return (
            <ErrorCard
              title="Invitation expired"
              body="This invitation has expired. Ask an admin to send you a new one."
            />
          );
        }
        if (result.status === "accepted") {
          return (
            <ErrorCard
              title="Invitation already used"
              body="This invitation has already been accepted. Sign in to your account from the home page."
            />
          );
        }

        const invitation = result.invitation!;
        return (
          <div className="mx-auto max-w-md rounded-lg border border-hairline bg-surface px-6 py-8 text-center">
            <h1 className="text-base font-semibold text-ink">
              You&apos;re invited
            </h1>
            <p className="mt-2 text-[13px] text-muted">
              You&apos;ve been invited to AI Hub as{" "}
              <span className="font-medium text-ink">{invitation.email}</span>{" "}
              with the{" "}
              <span
                className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] uppercase tracking-wider ${
                  invitation.role === "admin"
                    ? "bg-accent/15 text-accent"
                    : "bg-subtle text-muted"
                }`}
              >
                {invitation.role}
              </span>{" "}
              role.
            </p>
            <p className="mt-3 text-[12px] text-muted">
              Sign in with the GitHub account that owns this email to accept.
            </p>
            <a
              href="/chat"
              className="mt-6 inline-flex items-center justify-center gap-2 rounded-md bg-ink px-4 py-2 text-[13px] font-medium text-canvas hover:opacity-90"
            >
              <GithubMark />
              Sign in with GitHub
            </a>
            <p className="mt-4 text-[11px] text-muted">
              Expires {new Date(invitation.expiresAt).toLocaleDateString()}.
            </p>
          </div>
        );
      })()}
    </main>
  );
}
