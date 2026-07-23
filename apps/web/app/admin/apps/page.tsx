import {
  apps,
  getDb,
  users,
  workspaceArtifacts,
} from "@ai-workspace/db";
import { desc, eq, isNull } from "drizzle-orm";
import Link from "next/link";
import { AdminAppPublicationActions } from "@/components/admin/AdminAppPublicationActions";
import { resolveAppPublication } from "@/lib/app-publication";
import { formatDateTime } from "@/lib/format-date";

export const dynamic = "force-dynamic";

export default async function AdminAppsPage() {
  const db = getDb();
  const rows = await db
    .select({
      app: apps,
      ownerName: users.displayName,
      ownerEmail: users.email,
      artifactMetadata: workspaceArtifacts.metadata,
      artifactUpdatedAt: workspaceArtifacts.updatedAt,
    })
    .from(apps)
    .innerJoin(users, eq(apps.ownerUserId, users.id))
    .leftJoin(
      workspaceArtifacts,
      eq(apps.liveArtifactId, workspaceArtifacts.id),
    )
    .where(isNull(apps.archivedAt))
    .orderBy(desc(apps.updatedAt));

  const publications = rows
    .filter(
      ({ app }) =>
        Boolean(app.liveVersionId || app.liveArtifactId) &&
        (app.status === "deployed" || app.status === "unpublished"),
    )
    .map((row) => ({
      ...row,
      publication: resolveAppPublication(
        row.artifactMetadata,
        row.artifactUpdatedAt ?? row.app.updatedAt,
        row.app.ownerUserId,
      ).metadata,
    }));

  return (
    <section className="flex flex-col gap-4 px-4 py-5 sm:px-6">
      <div>
        <h2 className="text-base font-semibold text-ink">Published apps</h2>
        <p className="mt-1 text-xs text-muted">
          Publication mode, connector manifest, owner, and emergency access
          controls.
        </p>
      </div>
      {publications.length === 0 ? (
        <p className="rounded-md border border-hairline px-4 py-6 text-sm text-muted">
          No published apps.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-hairline">
          <table className="min-w-full border-collapse text-left text-xs">
            <thead className="border-b border-hairline text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">App</th>
                <th className="px-3 py-2 font-medium">Owner</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Data</th>
                <th className="px-3 py-2 font-medium">Manifest</th>
                <th className="px-3 py-2 font-medium">Published</th>
                <th className="px-3 py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {publications.map(
                ({ app, ownerName, ownerEmail, publication }) => (
                  <tr
                    key={app.id}
                    className="border-b border-hairline last:border-b-0"
                  >
                    <td className="px-3 py-2">
                      <p className="font-medium text-ink">{app.name}</p>
                      <p className="text-muted">/apps/{app.slug}</p>
                    </td>
                    <td className="px-3 py-2">
                      <p className="text-ink">{ownerName}</p>
                      <p className="text-muted">{ownerEmail}</p>
                    </td>
                    <td className="px-3 py-2 capitalize text-ink">
                      {app.status}
                    </td>
                    <td className="px-3 py-2 text-ink">
                      {publication.dataMode === "live_via_viewer"
                        ? "Live via viewer"
                        : "Snapshot"}
                      <p className="text-muted">{publication.audience}</p>
                    </td>
                    <td className="px-3 py-2 text-muted">
                      {publication.connectorManifest.length > 0
                        ? publication.connectorManifest
                            .map((entry) => entry.catalogKey)
                            .join(", ")
                        : "None"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted">
                      {formatDateTime(publication.publishedAt)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-2">
                        {app.status === "deployed" ? (
                          <a
                            href={`/apps/${app.slug}`}
                            className="text-ink hover:underline"
                          >
                            Open
                          </a>
                        ) : null}
                        <Link
                          href={`/apps/manage/${app.id}`}
                          className="text-muted hover:text-ink"
                        >
                          Manage
                        </Link>
                        <AdminAppPublicationActions
                          appId={app.id}
                          status={app.status}
                          liveVersionId={app.liveVersionId}
                          dataMode={
                            publication.dataMode === "live_via_viewer"
                              ? "live_via_viewer"
                              : "snapshot"
                          }
                        />
                      </div>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
