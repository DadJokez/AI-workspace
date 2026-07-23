import { apps, getDb } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import {
  auditAppMutation,
  canAppRoleDeploy,
  createAppVersionForArtifact,
  deployAppVersion,
  loadAppVersion,
  isServableArtifact,
  resolveAppActorRole,
  scanArtifactForSecrets,
} from "@/lib/apps";
import { parseRequestedPublicationMode } from "@/lib/app-publication";
import {
  loadWorkspaceArtifactById,
  loadWorkspaceArtifactForUser,
} from "@/lib/workspace-artifacts";
import { appendRunEventBestEffort } from "@/lib/run-events";
import { parseDataBindings } from "@/lib/app-data-bindings";
import { outputProposalFromMetadata } from "@/lib/output-proposals";

export const dynamic = "force-dynamic";

/**
 * Publish a version: promote an app_versions row and keep live_artifact_id in
 * sync during migration. Promoting a draft and rolling back to an older version
 * are the same endpoint; the helper records the audit event.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const { artifactId, appVersionId, dataMode: rawDataMode } = (body ??
    {}) as Record<string, unknown>;
  const dataMode = parseRequestedPublicationMode(rawDataMode);
  if (!dataMode) {
    return NextResponse.json(
      {
        error: "invalid_data_mode",
        message: "Data mode must be snapshot or live_via_viewer.",
      },
      { status: 400 },
    );
  }
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
    const artifactProposal = outputProposalFromMetadata(artifact.metadata);
    if (artifactProposal && artifactProposal.status !== "accepted") {
      return NextResponse.json(
        {
          error: "version_not_deployable",
          message: "Review this proposal before publishing it as an app.",
        },
        { status: 409 },
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
  if (
    version.status === "discarded" ||
    version.status === "iterating" ||
    version.status === "superseded"
  ) {
    return NextResponse.json(
      {
        error: "version_not_deployable",
        message: "This proposal version is not deployable.",
      },
      { status: 409 },
    );
  }

  const artifact = await loadWorkspaceArtifactById({
    db,
    artifactId: version.artifactId,
  });
  if (!artifact) {
    return NextResponse.json({ error: "artifact_not_found" }, { status: 404 });
  }
  if (
    dataMode === "live_via_viewer" &&
    parseDataBindings(artifact.metadata).length === 0
  ) {
    return NextResponse.json(
      {
        error: "live_data_unavailable",
        message:
          "This version has no supported data bindings. Publish it as a snapshot.",
      },
      { status: 422 },
    );
  }
  const secretFindings = scanArtifactForSecrets(artifact);
  if (secretFindings.length > 0) {
    if (artifact.runId) {
      await appendRunEventBestEffort("app-deploy-run-event-error", {
        db,
        runId: artifact.runId,
        eventType: "app_version_validation_failed",
        status: "failed",
        label: "App validation failed",
        error: "Credential scan blocked deployment.",
        metadata: {
          check: "credential scan",
          appVersionNumber: version.versionNumber,
          filenames: [artifact.filename],
          failed: 1,
        },
      });
    }
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

  if (artifact.runId) {
    await appendRunEventBestEffort("app-deploy-run-event-error", {
      db,
      runId: artifact.runId,
      eventType: "app_version_validation_completed",
      status: "succeeded",
      label: "Validated app version",
      metadata: {
        check: "credential scan",
        appVersionNumber: version.versionNumber,
        filenames: [artifact.filename],
        passed: 1,
        failed: 0,
      },
    });
  }

  try {
    const updated = await deployAppVersion({
      db,
      app,
      version,
      actorUserId: sessionUser.id,
      dataMode,
    });
    if (artifact.runId) {
      await appendRunEventBestEffort("app-deploy-run-event-error", {
        db,
        runId: artifact.runId,
        eventType: "app_version_published",
        status: "succeeded",
        label: `Published ${app.name} · version ${version.versionNumber}`,
        metadata: {
          appVersionNumber: version.versionNumber,
          filenames: [artifact.filename],
        },
      });
    }
    return NextResponse.json({
      app: updated,
      versionId: version.id,
      url: `/apps/${app.slug}`,
    });
  } catch {
    if (artifact.runId) {
      await appendRunEventBestEffort("app-deploy-run-event-error", {
        db,
        runId: artifact.runId,
        eventType: "app_version_publish_failed",
        status: "failed",
        label: "App publish failed",
        error: "Could not publish this app version.",
        metadata: {
          appVersionNumber: version.versionNumber,
          filenames: [artifact.filename],
          failed: 1,
        },
      });
    }
    return NextResponse.json(
      {
        error: "deploy_failed",
        message: "Could not publish this app version.",
      },
      { status: 422 },
    );
  }
}
