import {
  appVersions,
  apps,
  auditLog,
  getDb,
  workspaceArtifacts,
} from "@ai-workspace/db";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import {
  auditAppMutation,
  canAppRoleDeploy,
  canAppRoleEdit,
  loadAppVersion,
  resolveAppActorRole,
} from "@/lib/apps";
import {
  decideOutputProposalMetadata,
  normalizeProposalReason,
} from "@/lib/output-proposals";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; versionId: string }> },
) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;
  const { id, versionId } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const decision = (body as Record<string, unknown> | null)?.decision;
  if (decision !== "discarded") {
    return NextResponse.json({ error: "invalid_decision" }, { status: 400 });
  }
  const reason = normalizeProposalReason(
    (body as Record<string, unknown> | null)?.reason,
  );
  const db = getDb();
  const appRows = await db.select().from(apps).where(eq(apps.id, id)).limit(1);
  const app = appRows[0];
  if (!app) return NextResponse.json({ error: "app_not_found" }, { status: 404 });
  const actorRole = await resolveAppActorRole(db, app, sessionUser);
  if (!canAppRoleEdit(actorRole)) {
    return NextResponse.json({ error: "app_not_found" }, { status: 404 });
  }
  const version = await loadAppVersion(db, app.id, versionId);
  if (
    !version ||
    version.status !== "proposed" ||
    version.id === app.liveVersionId
  ) {
    return NextResponse.json({ error: "version_not_found" }, { status: 404 });
  }
  if (!canAppRoleDeploy(actorRole) && version.createdByUserId !== sessionUser.id) {
    return NextResponse.json({ error: "version_not_found" }, { status: 404 });
  }

  const artifactRows = await db
    .select()
    .from(workspaceArtifacts)
    .where(eq(workspaceArtifacts.id, version.artifactId))
    .limit(1);
  const artifact = artifactRows[0];
  if (!artifact) {
    return NextResponse.json({ error: "artifact_not_found" }, { status: 404 });
  }
  const now = new Date();
  const metadata = decideOutputProposalMetadata({
    metadata: artifact.metadata,
    decision: "discarded",
    decidedAt: now,
    decidedByUserId: sessionUser.id,
    reason,
  });
  if (!metadata) {
    return NextResponse.json(
      { error: "proposal_not_pending" },
      { status: 409 },
    );
  }

  const discarded = await db.transaction(async (tx) => {
    const rows = await tx
      .update(appVersions)
      .set({ status: "discarded" })
      .where(
        and(
          eq(appVersions.id, version.id),
          eq(appVersions.status, "proposed"),
        ),
      )
      .returning({ id: appVersions.id });
    if (!rows[0]) return false;
    await tx
      .update(workspaceArtifacts)
      .set({ metadata, updatedAt: now })
      .where(eq(workspaceArtifacts.id, artifact.id));
    await tx.insert(auditLog).values({
      actorUserId: sessionUser.id,
      actionType: "proposal_discarded",
      status: "succeeded",
      provider: "ai-hub",
      toolName: app.slug,
      chatThreadId: version.sourceThreadId,
      runId: artifact.runId,
      input: {
        appId: app.id,
        appVersionId: version.id,
        artifactId: artifact.id,
      },
      metadata: {
        subjectType: "app_version",
        versionNumber: version.versionNumber,
        ...(reason ? { reason } : {}),
      },
      startedAt: now,
      completedAt: now,
    });
    return true;
  });
  if (!discarded) {
    return NextResponse.json(
      { error: "proposal_not_pending" },
      { status: 409 },
    );
  }
  return NextResponse.json({
    version: { id: version.id, status: "discarded" },
  });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; versionId: string }> },
) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;
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
    return NextResponse.json({ error: "version_not_found" }, { status: 404 });
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
