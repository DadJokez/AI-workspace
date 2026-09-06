import { apps, getDb } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppActions } from "@/components/apps/AppActions";
import { EditAppButton } from "@/components/apps/EditAppButton";
import { VersionsPanel } from "@/components/apps/VersionsPanel";
import { SharePanel } from "@/components/skills/SharePanel";
import { auditAdminDataAccess } from "@/lib/admin-data-access";
import {
  canAppRoleDeploy,
  canAppRoleEdit,
  listAppVersions,
  resolveAppActorRole,
} from "@/lib/apps";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import {
  describeConnectorManifest,
  resolveAppPublication,
} from "@/lib/app-publication";
import { listSharesForSubject } from "@/lib/shares";
import { loadWorkspaceArtifactById } from "@/lib/workspace-artifacts";

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
  if (!app) {
    notFound();
  }
  const actorRole = await resolveAppActorRole(db, app, sessionUser);
  if (!canAppRoleEdit(actorRole)) notFound();
  await auditAdminDataAccess({
    db,
    actor: sessionUser,
    access: {
      targetUserId: app.ownerUserId,
      resourceType: "app",
      resourceId: app.id,
      surface: "manage_app",
    },
  });
  const canDeploy = canAppRoleDeploy(actorRole);
  const canShare = actorRole === "owner" || actorRole === "admin";

  const [versions, appShares] = await Promise.all([
    listAppVersions(db, {
      appId: app.id,
      visibleToUserId: sessionUser.id,
      actorRole,
    }),
    canShare ? listSharesForSubject(db, "app", app.id) : Promise.resolve([]),
  ]);
  const liveVersion = versions.find((version) => version.isLive) ?? null;
  const liveArtifact = liveVersion
    ? await loadWorkspaceArtifactById({
        db,
        artifactId: liveVersion.artifactId,
      })
    : null;
  const publication = liveArtifact
    ? resolveAppPublication(
        liveArtifact.metadata,
        liveVersion?.deployedAt ?? liveArtifact.updatedAt,
        app.ownerUserId,
      ).metadata
    : null;
  // #802: the publish-time connector declaration — the only sources a live
  // version can read through, each under the viewer's own connection.
  const declaredSources =
    publication?.dataMode === "live_via_viewer"
      ? describeConnectorManifest(publication.connectorManifest)
      : [];

  return (
    <section className="flex flex-col gap-6 px-6 py-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs text-muted">
            <Link href="/apps" className="hover:text-ink">
              Apps
            </Link>{" "}
            / {app.name}
          </p>
          <h2 className="mt-1 text-base font-semibold text-ink">
            {app.name}
            {app.status === "unpublished" ? (
              <span className="ml-2 rounded bg-ink/5 px-1.5 py-0.5 text-2xs uppercase tracking-wide text-muted">
                Unpublished
              </span>
            ) : null}
            {app.archivedAt ? (
              <span className="ml-2 rounded bg-ink/5 px-1.5 py-0.5 text-2xs uppercase tracking-wide text-muted">
                Archived
              </span>
            ) : null}
          </h2>
          {app.description ? (
            <p className="mt-1 text-sm text-muted">{app.description}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {app.status === "deployed" &&
          (app.liveVersionId || app.liveArtifactId) &&
          !app.archivedAt ? (
            <a
              href={`/apps/${app.slug}`}
              className="rounded-md border border-hairline px-3 py-1.5 text-sm font-medium text-ink hover:bg-ink/5"
            >
              Open app
            </a>
          ) : null}
          {!app.archivedAt ? <EditAppButton appId={app.id} /> : null}
        </div>
      </div>

      <div className="rounded-md border border-hairline px-4 py-3 text-xs text-muted">
        Served at{" "}
        <code className="rounded bg-ink/5 px-1 py-0.5 text-ink">
          /apps/{app.slug}
        </code>{" "}
        behind workspace sign-in, with a restrictive content-security policy:
        inline page only — no external scripts, no network calls, no secrets in
        content (enforced at every publish).
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
        {declaredSources.length > 0 ? (
          <p className="mt-2">
            Declared data sources (read as each viewer, through their own
            connection):{" "}
            {declaredSources.map((source, index) => (
              <span key={source.catalogKey}>
                {index > 0 ? ", " : null}
                <code className="rounded bg-ink/5 px-1 py-0.5 text-ink">
                  {source.providerLabel} · {source.toolName}
                </code>
              </span>
            ))}
            . The page cannot call any other connector.
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="text-base font-semibold text-ink">Versions</h3>
        <p className="text-xs text-muted">
          Edits create draft versions. Unattended work waits as a proposal. The
          live URL stays stable until an owner accepts a proposal, publishes a
          draft, or rolls back to a prior version.
        </p>
        <VersionsPanel
          appId={app.id}
          canDeploy={canDeploy}
          versions={versions.map((artifact) => ({
            appVersionId: artifact.id,
            artifactId: artifact.artifactId,
            versionNumber: artifact.versionNumber,
            status: artifact.status,
            summary: artifact.summary,
            title: artifact.artifactTitle,
            filename: artifact.artifactFilename,
            createdAt: artifact.createdAt.toISOString(),
            deployedAt: artifact.deployedAt?.toISOString() ?? null,
            createdByName: artifact.createdByName,
            isLive: artifact.isLive,
            canDeploy:
              canDeploy &&
              !artifact.isLive &&
              artifact.status !== "discarded" &&
              artifact.status !== "iterating" &&
              artifact.status !== "superseded",
            canDiscard:
              (artifact.status === "draft" ||
                artifact.status === "proposed") &&
              (canDeploy || artifact.createdByUserId === sessionUser.id),
            hasDataBindings: artifact.hasDataBindings,
            previewUrl: `/api/apps/${app.id}/versions/${artifact.id}/content`,
          }))}
        />
      </div>

      {canShare ? (
        <div className="flex flex-col gap-3 border-t border-hairline pt-5">
          <h3 className="text-base font-semibold text-ink">Sharing</h3>
          {publication?.dataMode === "snapshot" ? (
            <p className="text-xs text-muted">
              Snapshot sharing grants recipients access to the baked content
              shown in this version, even if they cannot access the original
              data source.
            </p>
          ) : publication?.dataMode === "live_via_viewer" ? (
            <p className="text-xs text-muted">
              Live data runs under each viewer&apos;s own connected account.
              This app never uses the author&apos;s connector for another
              viewer.
              {declaredSources.length > 0 ? (
                <>
                  {" "}
                  Recipients will be asked to connect:{" "}
                  {declaredSources
                    .map((source) => `${source.providerLabel} (${source.toolName})`)
                    .join(", ")}
                  .
                </>
              ) : null}
            </p>
          ) : null}
          <SharePanel
            subjectType="app"
            subjectId={app.id}
            shares={appShares.map((share) => ({
              id: share.id,
              grantedToEmail: share.grantedToEmail,
              grantedToName: share.grantedToName,
              role: share.role,
            }))}
          />
        </div>
      ) : null}

      {!app.archivedAt && canDeploy ? (
        <div className="border-t border-hairline pt-5">
          {publication ? (
            <p className="mb-3 text-xs text-muted">
              Current data mode:{" "}
              <span className="font-medium text-ink">
                {publication.dataMode === "live_via_viewer"
                  ? "Live via viewer"
                  : "Snapshot"}
              </span>
              . Unpublishing keeps this URL and every version.
            </p>
          ) : null}
          <AppActions
            appId={app.id}
            status={app.status}
            liveVersionId={app.liveVersionId}
            dataMode={
              publication?.dataMode === "live_via_viewer"
                ? "live_via_viewer"
                : "snapshot"
            }
          />
        </div>
      ) : null}
    </section>
  );
}
