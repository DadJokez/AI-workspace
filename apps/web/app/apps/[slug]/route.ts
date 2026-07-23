import { apps, getDb } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  adminDataAccessJustification,
  auditAdminDataAccess,
} from "@/lib/admin-data-access";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { auditAppMutation, canActorOpenApp, getLiveAppVersion } from "@/lib/apps";
import { parseDataBindings } from "@/lib/app-data-bindings";
import {
  buildAppDataBootstrap,
  injectAppDataBootstrap,
} from "@/lib/app-data-bootstrap";
import { loadWorkspaceArtifactById } from "@/lib/workspace-artifacts";

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

// Live-data apps (#407, Rob-approved 2026-07-18): ONLY a binding-bearing app
// gets same-origin fetch — so it can call its own viewer-scoped data
// endpoint — and nothing else changes. Apps without bindings keep the fully
// closed sandbox above, byte-identical.
const APP_CSP_WITH_DATA = APP_CSP.replace(
  "connect-src 'none'",
  "connect-src 'self'",
);

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
  if (!app) {
    return new NextResponse("Not found", { status: 404 });
  }
  if (!(await canActorOpenApp(db, app, sessionUser))) {
    await auditAppMutation({
      db,
      actorUserId: sessionUser.id,
      actionType: "app_open_denied",
      appId: app.id,
      appSlug: app.slug,
      status: "denied",
      error: "User does not have access to open this app.",
    });
    return new NextResponse("Not found", { status: 404 });
  }

  // Content is loaded by app authorization, not by the artifacts API. That
  // lets editor-created drafts become live without exposing the editor's
  // workspace artifact library to viewers.
  const liveVersion = await getLiveAppVersion(db, app);
  const artifactId = liveVersion?.artifactId ?? app.liveArtifactId;
  if (!artifactId) {
    return new NextResponse("This app has no deployed version.", {
      status: 404,
    });
  }
  const artifact = await loadWorkspaceArtifactById({
    db,
    artifactId,
  });
  if (!artifact) {
    return new NextResponse("This app has no deployed version.", {
      status: 404,
    });
  }

  await auditAdminDataAccess({
    db,
    actor: sessionUser,
    access: {
      targetUserId: app.ownerUserId,
      resourceType: "workspace_artifact",
      resourceId: artifact.id,
      surface: "deployed_app",
      justification: adminDataAccessJustification(req),
    },
  });

  const bindings = parseDataBindings(artifact.metadata);
  const body =
    bindings.length > 0
      ? injectAppDataBootstrap(
          artifact.content,
          buildAppDataBootstrap(
            app.id,
            // Allowlist, never omit-the-secret: fields added to DataBinding
            // later stay server-side unless deliberately exposed here.
            bindings.map((binding) => ({
              id: binding.id,
              provider: binding.provider,
              kind: binding.kind,
              ...(binding.label ? { label: binding.label } : {}),
            })),
          ),
        )
      : artifact.content;

  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        bindings.length > 0 ? APP_CSP_WITH_DATA : APP_CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "private, no-store",
    },
  });
}
