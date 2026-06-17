import { appVersions, apps, getDb } from "@ai-workspace/db";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import {
  auditAppMutation,
  canAppRoleDeploy,
  canAppRoleEdit,
  loadAppVersion,
  resolveAppActorRole,
} from "@/lib/apps";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; versionId: string }> },
) {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id, versionId } = await params;
  const db = getDb();
  const appRows = await db.select().from(apps).where(eq(apps.id, id)).limit(1);
  const app = appRows[0];
  if (!app) return NextResponse.json({ error: "app_not_found" }, { status: 404 });
  const actorRole = await resolveAppActorRole(db, app, sessionUser);
  if (!canAppRoleEdit(actorRole)) {
    return NextResponse.json({ error: "app_not_found" }, { status: 404 });
  }
  const version = await loadAppVersion(db, app.id, versionId);
  if (!version || version.status !== "draft" || version.id === app.liveVersionId) {
    return NextResponse.json({ error: "version_not_found" }, { status: 404 });
  }
  if (!canAppRoleDeploy(actorRole) && version.createdByUserId !== sessionUser.id) {
    return NextResponse.json(
      { error: "not_allowed", message: "You can only discard your own draft versions." },
      { status: 403 },
    );
  }

  await db
    .delete(appVersions)
    .where(and(eq(appVersions.id, version.id), eq(appVersions.status, "draft")));
  await auditAppMutation({
    db,
    actorUserId: sessionUser.id,
    actionType: "app_update",
    appId: app.id,
    appSlug: app.slug,
    metadata: { discardedAppVersionId: version.id, artifactId: version.artifactId },
  });
  return NextResponse.json({ ok: true });
}
