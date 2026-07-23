import { apps, getDb } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import {
  auditAppMutation,
  canAppRoleDeploy,
  createAppVersionForArtifact,
  deployAppVersion,
  findCredentialShapedContent,
  loadAppVersion,
  isServableArtifact,
  resolveAppActorRole,
} from "@/lib/apps";
import {
  loadWorkspaceArtifactById,
  loadWorkspaceArtifactForUser,
} from "@/lib/workspace-artifacts";
import { getPostHogClient } from "@/lib/posthog-server";

export const dynamic = "force-dynamic";

/**
 * Deploy a version: promote an app_versions row and keep live_artifact_id in
 * sync during migration. Promoting a draft and rolling back to an older version
 * are the same endpoint; the helper records the audit event.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const { artifactId, appVersionId } = (body ?? {}) as Record<string, unknown>;
  if (
    (typeof appVersionId !== "string" || !appVersionId) &&
    (typeof artifactId !== "string" || !artifactId)
  ) {
    return NextResponse.json({ error: "invalid_version" }, { status: 400 });
  }

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
  if (app.archivedAt) {
    return NextResponse.json({ error: "app_archived" }, { status: 409 });
  }
  if (!canAppRoleDeploy(actorRole)) {
    await auditAppMutation({
      db,
      actorUserId: sessionUser.id,
      actionType: "app_deploy_denied",
      appId: app.id,
      appSlug: app.slug,
      status: "denied",
      error: "Only owners and admins can deploy app versions.",
      metadata: { appVersionId, artifactId },
    });
    return NextResponse.json(
      { error: "not_allowed", message: "Only owners and admins can deploy app versions." },
      { status: 403 },
    );
  }

  let version =
    typeof appVersionId === "string"
      ? await loadAppVersion(db, app.id, appVersionId)
      : null;
  if (!version && typeof artifactId === "string") {
    const artifact = await loadWorkspaceArtifactForUser({
      db,
      userId: app.ownerUserId,
      artifactId,
    });
    if (!artifact || artifact.threadId !== app.sourceThreadId) {
      return NextResponse.json(
        {
          error: "artifact_not_eligible",
          message:
            "Deployable versions are app draft versions or HTML artifacts from the conversation this app was built in.",
        },
        { status: 422 },
      );
    }
    if (!isServableArtifact(artifact)) {
      return NextResponse.json(
        { error: "artifact_not_servable" },
        { status: 422 },
      );
    }
    version = await createAppVersionForArtifact({
      db,
      app,
      artifactId: artifact.id,
      createdByUserId: sessionUser.id,
      status: "draft",
      summary: artifact.versionSummary,
    });
  }
  if (!version) {
    return NextResponse.json({ error: "version_not_found" }, { status: 404 });
  }

  const artifact = await loadWorkspaceArtifactById({
    db,
    artifactId: version.artifactId,
  });
  if (!artifact) {
    return NextResponse.json({ error: "artifact_not_found" }, { status: 404 });
  }
  const secretFindings = findCredentialShapedContent(artifact.content);
  if (secretFindings.length > 0) {
    await auditAppMutation({
      db,
      actorUserId: sessionUser.id,
      actionType: "app_deploy_failed_secret_scan",
      appId: app.id,
      appSlug: app.slug,
      status: "failed",
      error: "Deploy blocked by secret scan.",
      metadata: { appVersionId: version.id, artifactId: artifact.id, findings: secretFindings },
    });
    return NextResponse.json(
      {
        error: "deploy_blocked_secret_scan",
        message: `Deploy blocked: the document appears to contain ${secretFindings.join(
          " and ",
        )}.`,
      },
      { status: 422 },
    );
  }

  try {
    const updated = await deployAppVersion({
      db,
      app,
      version,
      actorUserId: sessionUser.id,
    });

    const posthog = getPostHogClient();
    posthog.capture({
      distinctId: sessionUser.id,
      event: "app_version_deployed",
      properties: { app_id: app.id, version_id: version.id },
    });
    await posthog.shutdown();

    return NextResponse.json({
      app: updated,
      versionId: version.id,
      url: `/apps/${app.slug}`,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "deploy_failed",
        message: err instanceof Error ? err.message : "Could not deploy this app version.",
      },
      { status: 422 },
    );
  }
}
