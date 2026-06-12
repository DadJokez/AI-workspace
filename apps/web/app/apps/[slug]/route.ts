import { apps, getDb } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { canActorOpenApp } from "@/lib/apps";
import { loadWorkspaceArtifactForUser } from "@/lib/workspace-artifacts";

export const dynamic = "force-dynamic";

/**
 * Serve a deployed app behind workspace sign-in. This is the J4 SSO seam in
 * its thinnest form: the workspace session *is* the app's auth, and the CSP
 * confines the document to a self-contained page — inline script/style only,
 * no network egress, no external resources, no framing by other origins.
 */
const APP_CSP = [
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
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    // Browser-facing surface: send humans to login rather than returning 401.
    return NextResponse.redirect(new URL("/login", req.url));
  }
  const { slug } = await params;

  const db = getDb();
  const rows = await db
    .select()
    .from(apps)
    .where(eq(apps.slug, slug))
    .limit(1);
  const app = rows[0];
  if (!app || !(await canActorOpenApp(db, app, sessionUser))) {
    return new NextResponse("Not found", { status: 404 });
  }

  // Content is loaded against the OWNER's artifact store — recipients open
  // the app without ever gaining access to the owner's artifacts API.
  const artifact = await loadWorkspaceArtifactForUser({
    db,
    userId: app.ownerUserId,
    artifactId: app.liveArtifactId!,
  });
  if (!artifact) {
    return new NextResponse("This app has no deployed version.", {
      status: 404,
    });
  }

  return new NextResponse(artifact.content, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": APP_CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "private, no-store",
    },
  });
}
