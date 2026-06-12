import { apps, getDb } from "@ai-workspace/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import {
  auditAppMutation,
  findCredentialShapedContent,
  insertAppWithUniqueSlug,
  isServableArtifact,
  listAppsSharedWith,
  parseAppInput,
} from "@/lib/apps";
import { loadWorkspaceArtifactForUser } from "@/lib/workspace-artifacts";

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
  const shared = await listAppsSharedWith(db, sessionUser.id);
  const mineIds = new Set(mine.map((a) => a.id));

  const serialize = (app: (typeof mine)[number], sharedWithMe: boolean) => ({
    id: app.id,
    slug: app.slug,
    name: app.name,
    description: app.description,
    status: app.status,
    isOwner: app.ownerUserId === sessionUser.id,
    sharedWithMe,
    url: `/apps/${app.slug}`,
    updatedAt: app.updatedAt,
  });

  return NextResponse.json({
    apps: [
      ...mine.map((a) => serialize(a, false)),
      ...shared.filter((a) => !mineIds.has(a.id)).map((a) => serialize(a, true)),
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
  if (!isServableArtifact(artifact)) {
    return NextResponse.json(
      {
        error: "artifact_not_servable",
        message: "Only self-contained HTML artifacts can be deployed as apps.",
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

  await auditAppMutation({
    db,
    actorUserId: sessionUser.id,
    actionType: "app_register",
    appId: app.id,
    appSlug: app.slug,
    metadata: { artifactId: artifact.id, sourceThreadId: artifact.threadId },
  });

  return NextResponse.json(
    { app, url: `/apps/${app.slug}` },
    { status: 201 },
  );
}
