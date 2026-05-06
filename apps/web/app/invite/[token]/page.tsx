import { getDb, invitations } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { classifyInvitation, type InviteLookup } from "@/lib/invitations";

export const dynamic = "force-dynamic";

async function lookup(token: string): Promise<InviteLookup> {
  const db = getDb();
  const rows = await db
    .select()
    .from(invitations)
    .where(eq(invitations.token, token))
    .limit(1);
  return classifyInvitation(rows[0]);
}

function ErrorPanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto mt-24 max-w-md rounded-md border border-hairline bg-canvas p-6 text-center">
      <h1 className="text-base font-semibold text-ink">{title}</h1>
      <p className="mt-2 text-[13px] text-muted">{body}</p>
      <p className="mt-6 text-[12px] text-muted">
        Ask your admin to send a fresh invitation link.
      </p>
    </div>
  );
}

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const outcome = await lookup(token);

  if (outcome.kind === "not_found") {
    return (
      <ErrorPanel
        title="Invitation not found"
        body="This link doesn't match any invitation we know about. It may have been revoked or mistyped."
      />
    );
  }
  if (outcome.kind === "expired") {
    return (
      <ErrorPanel
        title="Invitation expired"
        body="This invitation is past its 7-day expiry. You'll need a new link before you can sign in."
      />
    );
  }
  if (outcome.kind === "used") {
    return (
      <ErrorPanel
        title="Invitation already used"
        body="Someone has already accepted this invitation. If that wasn't you, contact your admin."
      />
    );
  }

  return (
    <div className="mx-auto mt-24 max-w-md rounded-md border border-hairline bg-canvas p-6 text-center">
      <h1 className="text-base font-semibold text-ink">You&apos;re invited</h1>
      <p className="mt-2 text-[13px] text-muted">
        AI Hub access for{" "}
        <span className="font-medium text-ink">{outcome.email}</span>
      </p>
      <p className="mt-1 text-[12px] text-muted">
        Role on first sign-in:{" "}
        <span className="inline-flex items-center rounded bg-subtle px-2 py-0.5 text-[11px] uppercase tracking-wider text-ink">
          {outcome.role}
        </span>
      </p>
      <Link
        href="/api/oauth/github/start"
        className="mt-6 inline-flex items-center justify-center gap-2 rounded-md bg-ink px-4 py-2 text-[13px] font-medium text-canvas hover:opacity-90"
      >
        <GitHubMark /> Sign in with GitHub
      </Link>
      <p className="mt-4 text-[11px] text-muted">
        Sign in with the GitHub account that owns{" "}
        <span className="font-medium">{outcome.email}</span>. Your role will be
        applied automatically when your account is created.
      </p>
    </div>
  );
}

function GitHubMark() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="currentColor"
      aria-hidden
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
