import { apps, getDb } from "@ai-workspace/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import {
  auditAppMutation,
  createAppVersionForArtifact,
  findCredentialShapedContent,
  insertAppWithUniqueSlug,
  isCompleteHtmlArtifact,
  isServableArtifact,
  listAppSharesWithRoles,
  parseAppInput,
} from "@/lib/apps";
import { loadWorkspaceArtifactForUser } from "@/lib/workspace-artifacts";
import { getPostHogClient } from "@/lib/posthog-server";

export const dynamic = "force-dynamic";

/** List apps: mine plus shared with me. */
export async function GET() {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const mine = await db
    .select()
    .from(apps)
    .where(
      and(eq(apps.ownerUserId, sessionUser.id), isNull(apps.archivedAt)),
    )
    .orderBy(desc(apps.updatedAt));
  const shared = await listAppSharesWithRoles(db, sessionUser.id);
  const mineIds = new Set(mine.map((a) => a.id));

  const serialize = (
    app: (typeof mine)[number],
    sharedWithMe: boolean,
    shareRole?: string,
  ) => ({
    id: app.id,
    slug: app.slug,
    name: app.name,
    description: app.description,
    status: app.status,
    isOwner: app.ownerUserId === sessionUser.id,
    sharedWithMe,
    shareRole: shareRole ?? null,
    url: `/apps/${app.slug}`,
    updatedAt: app.updatedAt,
  });

  return NextResponse.json({
    apps: [
      ...mine.map((a) => serialize(a, false)),
      ...shared
        .filter(({ app }) => !mineIds.has(app.id))
        .map(({ app, role }) => serialize(app, true, role)),
    ],
  });
}

/**
 * Register an app from a chat-generated artifact and deploy it in one step.
 * The artifact must be the caller's own, servable HTML, and pass the
 * no-secrets scan (FR-014) before anything is persisted.
 */
export async function POST(req: Request) {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

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
  const parsed = parseAppInput(body);
  if (!parsed.ok) {
    return NextResponse.json(
      {
        error: "invalid_app",
        field: parsed.error.field,
        message: parsed.error.message,
      },
      { status: 400 },
    );
  }

  const db = getDb();
  const artifact = await loadWorkspaceArtifactForUser({
    db,
    userId: sessionUser.id,
    artifactId,
  });
  if (!artifact) {
    return NextResponse.json({ error: "artifact_not_found" }, { status: 404 });
  }
  if (!isServableArtifact(artifact) || !isCompleteHtmlArtifact(artifact)) {
    return NextResponse.json(
      {
        error: "artifact_not_servable",
        message:
          "Only complete self-contained HTML documents can be deployed as apps.",
      },
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
        )}. Remove credentials and try again — secrets belong in Secrets Manager, never in app content.`,
      },
      { status: 422 },
    );
  }

  const app = await insertAppWithUniqueSlug(db, {
    name: parsed.input.name,
    description: parsed.input.description,
    ownerUserId: sessionUser.id,
    liveArtifactId: artifact.id,
    status: "deployed",
    sourceThreadId: artifact.threadId,
  });
  const initialVersion = await createAppVersionForArtifact({
    db,
    app,
    artifactId: artifact.id,
    createdByUserId: sessionUser.id,
    status: "deployed",
    summary: artifact.versionSummary ?? "Initial deployed app version.",
    deployedAt: new Date(),
  });
  const updated = await db
    .update(apps)
    .set({ liveVersionId: initialVersion.id, updatedAt: new Date() })
    .where(eq(apps.id, app.id))
    .returning();

  await auditAppMutation({
    db,
    actorUserId: sessionUser.id,
    actionType: "app_register",
    appId: app.id,
    appSlug: app.slug,
    metadata: {
      artifactId: artifact.id,
      appVersionId: initialVersion.id,
      sourceThreadId: artifact.threadId,
    },
  });

  const posthog = getPostHogClient();
  posthog.capture({
    distinctId: sessionUser.id,
    event: "app_registered",
    properties: { app_id: app.id },
  });
  await posthog.shutdown();

  return NextResponse.json(
    { app: updated[0] ?? app, url: `/apps/${app.slug}` },
    { status: 201 },
  );
}
