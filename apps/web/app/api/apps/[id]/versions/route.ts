import { apps, getDb } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  adminDataAccessJustification,
  auditAdminDataAccess,
} from "@/lib/admin-data-access";
import { requireSession } from "@/lib/auth/requireSession";
import {
  canAppRoleDeploy,
  canAppRoleEdit,
  listAppVersions,
  resolveAppActorRole,
} from "@/lib/apps";

export const dynamic = "force-dynamic";

/** Owner-only: the app's deployable version candidates, newest first. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;
  const { id } = await params;

  const db = getDb();
  const rows = await db.select().from(apps).where(eq(apps.id, id)).limit(1);
  const app = rows[0];
  if (!app) {
    return NextResponse.json({ error: "app_not_found" }, { status: 404 });
  }
  const actorRole = await resolveAppActorRole(db, app, sessionUser);
  if (!canAppRoleEdit(actorRole)) {
    return NextResponse.json({ error: "app_not_found" }, { status: 404 });
  }

  await auditAdminDataAccess({
    db,
    actor: sessionUser,
    access: {
      targetUserId: app.ownerUserId,
      resourceType: "app",
      resourceId: app.id,
      surface: "app_versions",
      justification: adminDataAccessJustification(req),
    },
  });

  const versions = await listAppVersions(db, {
    appId: app.id,
    visibleToUserId: sessionUser.id,
    actorRole,
  });

  return NextResponse.json({
    versions: versions.map((version) => ({
      id: version.id,
      appVersionId: version.id,
      artifactId: version.artifactId,
      versionNumber: version.versionNumber,
      status: version.status,
      summary: version.summary,
      title: version.artifactTitle,
      filename: version.artifactFilename,
      sizeBytes: version.artifactSizeBytes,
      createdByName: version.createdByName,
      createdByEmail: version.createdByEmail,
      createdAt: version.createdAt,
      deployedAt: version.deployedAt,
      isLive: version.isLive,
      canDeploy:
        canAppRoleDeploy(actorRole) &&
        !version.isLive &&
        version.status !== "discarded" &&
        version.status !== "iterating" &&
        version.status !== "superseded",
      canDiscard:
        (version.status === "draft" || version.status === "proposed") &&
        (canAppRoleDeploy(actorRole) ||
          version.createdByUserId === sessionUser.id),
      previewUrl: `/api/apps/${app.id}/versions/${version.id}/content`,
    })),
  });
}
