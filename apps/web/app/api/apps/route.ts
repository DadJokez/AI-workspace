import { apps, getDb } from "@ai-workspace/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import {
  auditAppMutation,
  createAppVersionForArtifact,
  deployAppVersion,
  insertAppWithUniqueSlug,
  isCompleteHtmlArtifact,
  isServableArtifact,
  listAppSharesWithRoles,
  parseAppInput,
  scanArtifactForSecrets,
} from "@/lib/apps";
import { parseRequestedPublicationMode } from "@/lib/app-publication";
import { loadWorkspaceArtifactForUser } from "@/lib/workspace-artifacts";
import { parseDataBindings } from "@/lib/app-data-bindings";
import { capturePostHogEvent } from "@/lib/posthog-server";

export const dynamic = "force-dynamic";

/** List apps: mine plus shared with me. */
export async function GET() {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;

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
 * Register an app from a chat-generated artifact and publish it in one step.
 * The artifact must be the caller's own, servable HTML, and pass the
 * no-secrets scan (FR-014) before anything is persisted.
 */
export async function POST(req: Request) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;

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
  const dataMode = parseRequestedPublicationMode(
    (body as Record<string, unknown>).dataMode,
  );
  if (!dataMode) {
    return NextResponse.json(
      {
        error: "invalid_data_mode",
        message: "Data mode must be snapshot or live_via_viewer.",
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
          "Only complete self-contained HTML documents can be published as apps.",
      },
      { status: 422 },
    );
  }
  if (
    dataMode === "live_via_viewer" &&
    parseDataBindings(artifact.metadata).length === 0
  ) {
    return NextResponse.json(
      {
        error: "live_data_unavailable",
        message:
          "This artifact has no supported data bindings. Publish it as a snapshot.",
      },
      { status: 422 },
    );
  }
  const secretFindings = scanArtifactForSecrets(artifact);
  if (secretFindings.length > 0) {
    return NextResponse.json(
      {
        error: "credential_shaped_content",
        message: `Publish blocked: the document appears to contain ${secretFindings.join(
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
    liveArtifactId: null,
    status: "draft",
    sourceThreadId: artifact.threadId,
  });
  const initialVersion = await createAppVersionForArtifact({
    db,
    app,
    artifactId: artifact.id,
    createdByUserId: sessionUser.id,
    status: "draft",
    summary: artifact.versionSummary ?? "Initial published app version.",
    deployedAt: null,
  });
  let published;
  try {
    published = await deployAppVersion({
      db,
      app,
      version: initialVersion,
      actorUserId: sessionUser.id,
      dataMode,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not publish the app.";
    return NextResponse.json(
      { error: "publish_failed", message },
      { status: 422 },
    );
  }

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
      dataMode,
    },
  });

  capturePostHogEvent({
    distinctId: sessionUser.id,
    event: "app_registered",
    properties: { app_id: app.id },
  });

  return NextResponse.json(
    { app: published, url: `/apps/${app.slug}` },
    { status: 201 },
  );
}
