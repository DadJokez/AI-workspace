import { apps, getDb } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import {
  canAppRoleDeploy,
  canAppRoleEdit,
  loadAppVersion,
  resolveAppActorRole,
} from "@/lib/apps";
import { loadWorkspaceArtifactById } from "@/lib/workspace-artifacts";

export const dynamic = "force-dynamic";

const PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join("; ");

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; versionId: string }> },
) {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id, versionId } = await params;
  const db = getDb();
  const appRows = await db.select().from(apps).where(eq(apps.id, id)).limit(1);
  const app = appRows[0];
  if (!app) return new NextResponse("Not found", { status: 404 });
  const actorRole = await resolveAppActorRole(db, app, sessionUser);
  if (!canAppRoleEdit(actorRole)) {
    return new NextResponse("Not found", { status: 404 });
  }
  const version = await loadAppVersion(db, app.id, versionId);
  if (!version) return new NextResponse("Not found", { status: 404 });
  if (
    actorRole === "editor" &&
    version.status === "draft" &&
    version.createdByUserId !== sessionUser.id &&
    !canAppRoleDeploy(actorRole)
  ) {
    return new NextResponse("Not found", { status: 404 });
  }
  const artifact = await loadWorkspaceArtifactById({
    db,
    artifactId: version.artifactId,
  });
  if (!artifact) return new NextResponse("Not found", { status: 404 });

  return new NextResponse(artifact.content, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": PREVIEW_CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "private, no-store",
    },
  });
}
