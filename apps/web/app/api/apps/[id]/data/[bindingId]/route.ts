import { apps, getDb } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  adminDataAccessJustification,
  auditAdminDataAccess,
} from "@/lib/admin-data-access";
import { requireSession } from "@/lib/auth/requireSession";
import {
  auditAppMutation,
  canActorOpenApp,
  getLiveAppVersion,
} from "@/lib/apps";
import { loadWorkspaceArtifactById } from "@/lib/workspace-artifacts";
import { loadAppVersionDataBindings } from "@/lib/app-version-bindings";
import { executeAppDataBinding } from "@/lib/app-data-execution";
import {
  isBindingIncludedInPublication,
  isPublicationManifestEnabled,
  resolveAppPublication,
} from "@/lib/app-publication";
import { checkRateLimit } from "@/lib/request-limits";

export const dynamic = "force-dynamic";

const DATA_JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} as const;

/**
 * Live-data app refresh (#407, generalized in #802). Executes a read tool
 * call PINNED on the deployed app version under the REQUESTING VIEWER's own
 * connection — never the author's. Brittany sees Brittany's rows; Conner
 * sees Conner's; a viewer with no connection gets an honest connect prompt,
 * never someone else's data. The browser submits a binding id only.
 *
 * Guard order, scoped to the viewer:
 *   auth → app exists → viewer may open → rate limit → binding declared on
 *   the LIVE version (server-side declaration enforcement) → manifest tools
 *   still enabled read-only → viewer's own connection + attestation + policy
 *   → execute → audit (per viewer).
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; bindingId: string }> },
) {
  const session = await requireSession();
  if ("error" in session) return session.error;
  const sessionUser = session.user;
  const { id, bindingId } = await params;
  const db = getDb();

  const appRows = await db.select().from(apps).where(eq(apps.id, id)).limit(1);
  const app = appRows[0];
  // 404 (not 403) on missing OR unauthorized — never leak app existence.
  if (!app) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (!(await canActorOpenApp(db, app, sessionUser))) {
    await auditAppMutation({
      db,
      actorUserId: sessionUser.id,
      actionType: "app_data_denied",
      appId: app.id,
      appSlug: app.slug,
      status: "denied",
      error: "Viewer cannot open this app.",
      metadata: { bindingId },
    });
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await auditAdminDataAccess({
    db,
    actor: sessionUser,
    access: {
      targetUserId: app.ownerUserId,
      resourceType: "app",
      resourceId: app.id,
      surface: "app_data",
      justification: adminDataAccessJustification(req),
    },
  });

  // Per-viewer + per-app rate limit (Postgres-backed, holds across instances).
  const limit = await checkRateLimit(
    db,
    `app-data:${sessionUser.id}:${app.id}`,
  );
  if (!limit.allowed) {
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Too many refreshes. Try again shortly.",
        retryAfterSeconds: limit.retryAfterSeconds,
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(limit.retryAfterSeconds),
          "X-RateLimit-Limit": String(limit.limit),
          "X-RateLimit-Remaining": String(limit.remaining),
          "X-RateLimit-Reset": limit.resetAt.toISOString(),
        },
      },
    );
  }

  // Resolve the binding from the DEPLOYED version's pinned declarations —
  // a binding executes only if it belongs to the version being served.
  const liveVersion = await getLiveAppVersion(db, app);
  const artifactId = liveVersion?.artifactId ?? app.liveArtifactId;
  if (!artifactId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const artifact = await loadWorkspaceArtifactById({ db, artifactId });
  const publication = artifact
    ? resolveAppPublication(
        artifact.metadata,
        liveVersion?.deployedAt ?? artifact.updatedAt,
        app.ownerUserId,
      ).metadata
    : null;
  const binding = artifact
    ? (
        await loadAppVersionDataBindings(db, {
          appVersionId: liveVersion?.id ?? null,
          artifactMetadata: artifact.metadata,
        })
      ).find((candidate) => candidate.id === bindingId) ?? null
    : null;
  if (
    !publication ||
    !binding ||
    publication.dataMode !== "live_via_viewer" ||
    !isBindingIncludedInPublication(publication, binding) ||
    !(await isPublicationManifestEnabled(db, publication))
  ) {
    await auditAppMutation({
      db,
      actorUserId: sessionUser.id,
      actionType: "app_data_denied",
      appId: app.id,
      appSlug: app.slug,
      status: "denied",
      error: "Published app does not have an enabled live-via-viewer manifest.",
      metadata: { bindingId },
    });
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Execute as the VIEWER — the scoping boundary. Never the author.
  const result = await executeAppDataBinding({
    db,
    viewerUserId: sessionUser.id,
    binding,
  });
  const auditMetadata = {
    bindingId,
    provider: binding.provider,
    toolName: binding.toolName,
  };

  switch (result.kind) {
    case "invalid_binding": {
      await auditAppMutation({
        db,
        actorUserId: sessionUser.id,
        actionType: "app_data_denied",
        appId: app.id,
        appSlug: app.slug,
        status: "failed",
        error: "Pinned binding arguments failed read-only validation.",
        metadata: auditMetadata,
      });
      return NextResponse.json({ error: "invalid_binding" }, { status: 422 });
    }
    case "denied": {
      await auditAppMutation({
        db,
        actorUserId: sessionUser.id,
        actionType: "app_data_denied",
        appId: app.id,
        appSlug: app.slug,
        status: "denied",
        error: result.reason,
        metadata: auditMetadata,
      });
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    case "needs_connection": {
      await auditAppMutation({
        db,
        actorUserId: sessionUser.id,
        actionType: "app_data_refresh",
        appId: app.id,
        appSlug: app.slug,
        status: "succeeded",
        metadata: {
          ...auditMetadata,
          outcome: `connection_${result.connectionStatus}`,
        },
      });
      // 200 with an honest connect state — the app renders a "Connect
      // <provider>" prompt, never another viewer's data.
      return NextResponse.json(
        {
          ok: false,
          needsConnection: true,
          provider: binding.provider,
          connectionStatus: result.connectionStatus,
        },
        { status: 200, headers: DATA_JSON_HEADERS },
      );
    }
    case "source_error": {
      // Only a status category survives: providers echo submitted arguments
      // in their error text, and the author's pinned arguments must never
      // reach a viewer's browser or the audit row.
      await auditAppMutation({
        db,
        actorUserId: sessionUser.id,
        actionType: "app_data_refresh",
        appId: app.id,
        appSlug: app.slug,
        status: "failed",
        error: result.category,
        metadata: auditMetadata,
      });
      return NextResponse.json(
        {
          ok: false,
          error: "data_source_error",
          message: "The data source could not be reached.",
        },
        { status: 502, headers: DATA_JSON_HEADERS },
      );
    }
    case "ok": {
      await auditAppMutation({
        db,
        actorUserId: sessionUser.id,
        actionType: "app_data_refresh",
        appId: app.id,
        appSlug: app.slug,
        status: "succeeded",
        metadata: {
          ...auditMetadata,
          ...(result.rowCount !== undefined ? { rowCount: result.rowCount } : {}),
        },
      });
      return NextResponse.json(
        {
          ok: true,
          bindingId: binding.id,
          provider: binding.provider,
          toolName: binding.toolName,
          data: result.data,
          ...(result.legacyFields ?? {}),
        },
        { status: 200, headers: DATA_JSON_HEADERS },
      );
    }
  }
}
