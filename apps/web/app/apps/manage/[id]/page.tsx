import { apps, getDb } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppActions } from "@/components/apps/AppActions";
import { VersionsPanel } from "@/components/apps/VersionsPanel";
import { SharePanel } from "@/components/skills/SharePanel";
import { listAppVersionCandidates } from "@/lib/apps";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { listSharesForSubject } from "@/lib/shares";

export const dynamic = "force-dynamic";

/** Owner console for one app: live URL, versions, sharing, archive. */
export default async function ManageAppPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const sessionUser = await getSessionUser();
  if (!sessionUser) redirect("/login");
  const { id } = await params;

  const db = getDb();
  const rows = await db.select().from(apps).where(eq(apps.id, id)).limit(1);
  const app = rows[0];
  if (
    !app ||
    (app.ownerUserId !== sessionUser.id && sessionUser.role !== "admin")
  ) {
    notFound();
  }

  const [versions, appShares] = await Promise.all([
    listAppVersionCandidates(db, {
      ownerUserId: app.ownerUserId,
      sourceThreadId: app.sourceThreadId,
    }),
    listSharesForSubject(db, "app", app.id),
  ]);

  return (
    <section className="flex flex-col gap-6 px-6 py-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[12px] text-muted">
            <Link href="/apps" className="hover:text-ink">
              Apps
            </Link>{" "}
            / {app.name}
          </p>
          <h2 className="mt-1 text-base font-semibold text-ink">
            {app.name}
            {app.archivedAt ? (
              <span className="ml-2 rounded bg-ink/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                Archived
              </span>
            ) : null}
          </h2>
          {app.description ? (
            <p className="mt-1 text-[13px] text-muted">{app.description}</p>
          ) : null}
        </div>
        {app.status === "deployed" && app.liveArtifactId && !app.archivedAt ? (
          <a
            href={`/apps/${app.slug}`}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 rounded-md border border-hairline px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-ink/5"
          >
            Open app ↗
          </a>
        ) : null}
      </div>

      <div className="rounded-md border border-hairline px-4 py-3 text-[12px] text-muted">
        Served at{" "}
        <code className="rounded bg-ink/5 px-1 py-0.5 text-ink">
          /apps/{app.slug}
        </code>{" "}
        behind workspace sign-in, with a restrictive content-security policy:
        inline page only — no external scripts, no network calls, no secrets in
        content (enforced at every deploy).
        {app.sourceThreadId ? (
          <>
            {" "}
            Built in{" "}
            <Link
              href={`/chat?threadId=${app.sourceThreadId}`}
              className="text-ink hover:underline"
            >
              this conversation
            </Link>
            .
          </>
        ) : null}
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="text-[14px] font-semibold text-ink">Versions</h3>
        <p className="text-[12px] text-muted">
          Every HTML artifact from the source conversation is a deployable
          version — keep iterating in chat to create new ones, deploy or
          revert here.
        </p>
        <VersionsPanel
          appId={app.id}
          versions={versions.map((artifact) => ({
            artifactId: artifact.id,
            title: artifact.title,
            filename: artifact.filename,
            createdAt: artifact.createdAt.toISOString(),
            isLive: artifact.id === app.liveArtifactId,
            previewUrl: `/api/workspace/artifacts/${artifact.id}`,
          }))}
        />
      </div>

      <div className="flex flex-col gap-3 border-t border-hairline pt-5">
        <h3 className="text-[14px] font-semibold text-ink">Sharing</h3>
        <SharePanel
          subjectType="app"
          subjectId={app.id}
          shares={appShares.map((share) => ({
            id: share.id,
            grantedToEmail: share.grantedToEmail,
            grantedToName: share.grantedToName,
          }))}
        />
      </div>

      {!app.archivedAt ? (
        <div className="border-t border-hairline pt-5">
          <AppActions appId={app.id} />
        </div>
      ) : null}
    </section>
  );
}
