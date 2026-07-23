import { DEFAULT_MODEL_ID } from "@ai-workspace/agent";
import { apps, getDb } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/requireSession";
import {
  auditAppMutation,
  canActorEditApp,
  startOrResumeAppEditSession,
} from "@/lib/apps";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;
  const { id } = await params;
  const db = getDb();
  const appRows = await db.select().from(apps).where(eq(apps.id, id)).limit(1);
  const app = appRows[0];
  if (!app) return NextResponse.json({ error: "app_not_found" }, { status: 404 });
  if (app.archivedAt) {
    return NextResponse.json({ error: "app_archived" }, { status: 409 });
  }
  if (!(await canActorEditApp(db, app, sessionUser))) {
    await auditAppMutation({
      db,
      actorUserId: sessionUser.id,
      actionType: "app_edit_denied",
      appId: app.id,
      appSlug: app.slug,
      status: "denied",
      error: "User does not have app edit access.",
    });
    return NextResponse.json(
      { error: "not_allowed", message: "You do not have edit access to this app." },
      { status: 403 },
    );
  }

  try {
    const session = await startOrResumeAppEditSession({
      db,
      app,
      actor: sessionUser,
      defaultModelId: DEFAULT_MODEL_ID,
    });
    return NextResponse.json({
      editSessionId: session.session.id,
      threadId: session.threadId,
      resumed: session.resumed,
      url: `/chat?threadId=${session.threadId}`,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "edit_session_failed",
        message:
          err instanceof Error ? err.message : "Could not start an app edit session.",
      },
      { status: 422 },
    );
  }
}
