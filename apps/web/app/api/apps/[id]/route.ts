import { type App, apps, getDb } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  adminDataAccessJustification,
  auditAdminDataAccess,
} from "@/lib/admin-data-access";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import {
  auditAppMutation,
  canActorAccessApp,
  resolveAppActorRole,
  parseAppInput,
} from "@/lib/apps";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

async function loadApp(id: string): Promise<App | null> {
  const db = getDb();
  const rows = await db.select().from(apps).where(eq(apps.id, id)).limit(1);
  return rows[0] ?? null;
}

function notFound() {
  return NextResponse.json({ error: "app_not_found" }, { status: 404 });
}

export async function GET(req: Request, context: RouteContext) {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await context.params;
  const db = getDb();
  const app = await loadApp(id);
  if (!app || !(await canActorAccessApp(db, app, sessionUser))) {
    return notFound();
  }
  await auditAdminDataAccess({
    db,
    actor: sessionUser,
    access: {
      targetUserId: app.ownerUserId,
      resourceType: "app",
      resourceId: app.id,
      surface: "app_api",
      justification: adminDataAccessJustification(req),
    },
  });
  const actorRole = await resolveAppActorRole(db, app, sessionUser);
  return NextResponse.json({
    app: {
      ...app,
      isOwner: app.ownerUserId === sessionUser.id,
      actorRole,
      canEdit:
        actorRole === "owner" || actorRole === "admin" || actorRole === "editor",
      canDeploy: actorRole === "owner" || actorRole === "admin",
    },
  });
}

export async function PATCH(req: Request, context: RouteContext) {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await context.params;
  const app = await loadApp(id);
  if (!app || !(await canActorAccessApp(getDb(), app, sessionUser))) {
    return notFound();
  }
  if (app.ownerUserId !== sessionUser.id) {
    return NextResponse.json(
      { error: "not_owner", message: "Only the app's owner can modify it." },
      { status: 403 },
    );
  }
  if (app.archivedAt) {
    return NextResponse.json({ error: "app_archived" }, { status: 409 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
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
  const rows = await db
    .update(apps)
    .set({
      name: parsed.input.name,
      description: parsed.input.description,
      updatedAt: new Date(),
    })
    .where(eq(apps.id, app.id))
    .returning();

  await auditAppMutation({
    db,
    actorUserId: sessionUser.id,
    actionType: "app_update",
    appId: app.id,
    appSlug: app.slug,
  });

  return NextResponse.json({ app: rows[0] });
}

/** Archive: the app stops serving and disappears from catalogs. */
export async function DELETE(_req: Request, context: RouteContext) {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await context.params;
  const app = await loadApp(id);
  if (!app || !(await canActorAccessApp(getDb(), app, sessionUser))) {
    return notFound();
  }
  if (app.ownerUserId !== sessionUser.id && sessionUser.role !== "admin") {
    return NextResponse.json(
      { error: "not_owner", message: "Only the app's owner can archive it." },
      { status: 403 },
    );
  }

  const db = getDb();
  const now = new Date();
  await db
    .update(apps)
    .set({ archivedAt: now, updatedAt: now })
    .where(eq(apps.id, app.id));

  await auditAppMutation({
    db,
    actorUserId: sessionUser.id,
    actionType: "app_archive",
    appId: app.id,
    appSlug: app.slug,
  });

  return NextResponse.json({ ok: true });
}
