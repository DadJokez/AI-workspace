import { apps, getDb, users } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  adminDataAccessJustification,
  auditAdminDataAccess,
} from "@/lib/admin-data-access";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { auditAppMutation, canActorOpenApp, getLiveAppVersion } from "@/lib/apps";
import { publicDataBinding } from "@/lib/app-data-bindings";
import {
  buildAppDataBootstrap,
  injectAppDataBootstrap,
} from "@/lib/app-data-bootstrap";
import { loadAppVersionDataBindings } from "@/lib/app-version-bindings";
import {
  injectAppPublicationBadge,
  isBindingIncludedInPublication,
  isPublicationManifestEnabled,
  resolveAppPublication,
} from "@/lib/app-publication";
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
    .select({ app: apps, ownerName: users.displayName })
    .from(apps)
    .innerJoin(users, eq(apps.ownerUserId, users.id))
    .where(eq(apps.slug, slug))
    .limit(1);
  const app = rows[0]?.app;
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

  // The version's pinned declarations (#802) — the same list the data
  // endpoint enforces against, so the page can only name bindings it can call.
  const bindings = await loadAppVersionDataBindings(db, {
    appVersionId: liveVersion?.id ?? null,
    artifactMetadata: artifact.metadata,
  });
  const publication = resolveAppPublication(
    artifact.metadata,
    liveVersion?.deployedAt ?? artifact.updatedAt,
    app.ownerUserId,
  ).metadata;
  if (publication.dataMode === "service_backed") {
    return new NextResponse(
      "This app uses a publication mode that is not available yet.",
      { status: 503 },
    );
  }
  if (
    publication.dataMode === "live_via_viewer" &&
    !(await isPublicationManifestEnabled(db, publication))
  ) {
    return new NextResponse(
      "This app's live data connector is unavailable. Contact a workspace administrator.",
      { status: 503 },
    );
  }
  const withRuntime =
    publication.dataMode === "live_via_viewer"
      ? injectAppDataBootstrap(
          artifact.content,
          buildAppDataBootstrap(
            app.id,
            // Allowlist, never omit-the-secret: `publicDataBinding` names the
            // viewer-visible fields; pinned arguments stay server-side.
            bindings
              .filter((binding) =>
                isBindingIncludedInPublication(publication, binding),
              )
              .map(publicDataBinding),
          ),
        )
      : artifact.content;
  const body = injectAppPublicationBadge(withRuntime, {
    publication,
    authorName: rows[0]?.ownerName ?? "Comparative user",
  });

  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        publication.dataMode === "live_via_viewer"
          ? APP_CSP_WITH_DATA
          : APP_CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "private, no-store",
    },
  });
}
