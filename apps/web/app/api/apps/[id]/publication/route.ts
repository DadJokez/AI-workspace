import { apps, getDb } from "@ai-workspace/db";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import {
  auditAppMutation,
  canAppRoleDeploy,
  resolveAppActorRole,
} from "@/lib/apps";

export const dynamic = "force-dynamic";

/** Stop serving an app while retaining its stable URL, content, and versions. */
export async function DELETE(
  _req: Request,
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
  if (actorRole === "none") {
    return NextResponse.json({ error: "app_not_found" }, { status: 404 });
  }
  if (!canAppRoleDeploy(actorRole)) {
    return NextResponse.json(
      {
        error: "not_allowed",
        message: "Only owners and admins can unpublish apps.",
      },
      { status: 403 },
    );
  }
  if (app.archivedAt) {
    return NextResponse.json({ error: "app_archived" }, { status: 409 });
  }
  if (app.status === "unpublished") {
    return NextResponse.json({ ok: true, app });
  }
  if (
    app.status !== "deployed" ||
    (!app.liveVersionId && !app.liveArtifactId)
  ) {
    return NextResponse.json(
      {
        error: "not_published",
        message: "This app does not have a published version.",
      },
      { status: 409 },
    );
  }

  const now = new Date();
  const updated = await db
    .update(apps)
    .set({ status: "unpublished", updatedAt: now })
    .where(and(eq(apps.id, app.id), eq(apps.status, "deployed")))
    .returning();
  if (!updated[0]) {
    return NextResponse.json(
      { error: "publication_changed", message: "The app changed. Try again." },
      { status: 409 },
    );
  }

  await auditAppMutation({
    db,
    actorUserId: sessionUser.id,
    actionType: "app_unpublish",
    appId: app.id,
    appSlug: app.slug,
    metadata: {
      appVersionId: app.liveVersionId,
      artifactId: app.liveArtifactId,
      retainedSlug: app.slug,
    },
  });

  return NextResponse.json({ ok: true, app: updated[0] });
}
