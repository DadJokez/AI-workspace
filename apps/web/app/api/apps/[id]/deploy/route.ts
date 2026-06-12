import { apps, getDb, workspaceArtifacts } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import {
  auditAppMutation,
  findCredentialShapedContent,
  isServableArtifact,
} from "@/lib/apps";
import { loadWorkspaceArtifactForUser } from "@/lib/workspace-artifacts";

export const dynamic = "force-dynamic";

/**
 * Deploy a version: repoint `live_artifact_id` at one of the app's version
 * candidates. Promoting a newer artifact and reverting to an older one are
 * the same mechanic; the audit row records which one it was. The no-secrets
 * scan (FR-014) re-runs on every deploy.
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
  const { artifactId } = (body ?? {}) as Record<string, unknown>;
  if (typeof artifactId !== "string" || !artifactId) {
    return NextResponse.json({ error: "invalid_artifact" }, { status: 400 });
  }

  const db = getDb();
  const rows = await db.select().from(apps).where(eq(apps.id, id)).limit(1);
  const app = rows[0];
  if (!app || app.ownerUserId !== sessionUser.id) {
    return NextResponse.json({ error: "app_not_found" }, { status: 404 });
  }
  if (app.archivedAt) {
    return NextResponse.json({ error: "app_archived" }, { status: 409 });
  }

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
          "Deployable versions are the HTML artifacts from the conversation this app was built in.",
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
  const secretFindings = findCredentialShapedContent(artifact.content);
  if (secretFindings.length > 0) {
    return NextResponse.json(
      {
        error: "credential_shaped_content",
        message: `Deploy blocked: the document appears to contain ${secretFindings.join(
          " and ",
        )}.`,
      },
      { status: 422 },
    );
  }

  const previousArtifactId = app.liveArtifactId;
  const isRevert =
    previousArtifactId !== null &&
    artifact.createdAt < (await artifactCreatedAt(db, previousArtifactId));

  const now = new Date();
  const updated = await db
    .update(apps)
    .set({
      liveArtifactId: artifact.id,
      status: "deployed",
      updatedAt: now,
    })
    .where(eq(apps.id, app.id))
    .returning();

  await auditAppMutation({
    db,
    actorUserId: sessionUser.id,
    actionType: isRevert ? "app_revert" : "app_deploy",
    appId: app.id,
    appSlug: app.slug,
    metadata: { artifactId: artifact.id, previousArtifactId },
  });

  return NextResponse.json({ app: updated[0], url: `/apps/${app.slug}` });
}

async function artifactCreatedAt(
  db: ReturnType<typeof getDb>,
  artifactId: string,
): Promise<Date> {
  const rows = await db
    .select({ createdAt: workspaceArtifacts.createdAt })
    .from(workspaceArtifacts)
    .where(eq(workspaceArtifacts.id, artifactId))
    .limit(1);
  return rows[0]?.createdAt ?? new Date(0);
}
