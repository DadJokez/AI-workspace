import { apps, getDb } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  adminDataAccessJustification,
  auditAdminDataAccess,
} from "@/lib/admin-data-access";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import {
  auditAppMutation,
  canActorOpenApp,
  getLiveAppVersion,
} from "@/lib/apps";
import { loadWorkspaceArtifactById } from "@/lib/workspace-artifacts";
import { findDataBinding } from "@/lib/app-data-bindings";
import { checkRateLimit } from "@/lib/request-limits";
import { resolveSalesforceConnection } from "@/lib/oauth/salesforce-token";
import { buildSalesforceTurnContext } from "@/lib/salesforce/authorization";
import {
  queryReadOnlySoql,
  SalesforceApiError,
  validateReadOnlySoql,
} from "@/lib/salesforce/api";

export const dynamic = "force-dynamic";

const DATA_JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} as const;

/**
 * Live-data app refresh (#407). Executes a query PINNED on the deployed app
 * version under the REQUESTING VIEWER's own connection — never the author's.
 * Brittany sees Brittany's rows; Conner sees Conner's; a viewer with no
 * connection gets an honest connect prompt, never someone else's data.
 *
 * Guard order mirrors `buildUserMcpServers`, scoped to the viewer:
 *   auth → app exists → viewer may open → rate limit → pinned binding →
 *   re-validate read-only → viewer's SFDC connection → execute → audit.
 *
 * NOTE: deployed apps are served with `connect-src 'none'`, so no in-product
 * app can call this yet — the CSP relaxation + client Refresh wiring is a
 * separate, sandbox-boundary change awaiting sign-off. This endpoint is the
 * server foundation and is exercised directly by tests.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; bindingId: string }> },
) {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
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

  // Read the binding from the DEPLOYED version's immutable artifact (the pin).
  const liveVersion = await getLiveAppVersion(db, app);
  const artifactId = liveVersion?.artifactId ?? app.liveArtifactId;
  if (!artifactId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const artifact = await loadWorkspaceArtifactById({ db, artifactId });
  const binding = artifact
    ? findDataBinding(artifact.metadata, bindingId)
    : null;
  if (!binding) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Defense-in-depth: metadata is mutable-in-principle, so re-validate the
  // pinned query is a single read-only SELECT before running it — never
  // trust that mint-time validation is still intact.
  let safeSoql: string;
  try {
    safeSoql = validateReadOnlySoql(binding.query);
  } catch {
    await auditAppMutation({
      db,
      actorUserId: sessionUser.id,
      actionType: "app_data_denied",
      appId: app.id,
      appSlug: app.slug,
      status: "failed",
      error: "Pinned binding query failed read-only validation.",
      metadata: { bindingId },
    });
    return NextResponse.json(
      { error: "invalid_binding" },
      { status: 422 },
    );
  }

  // Resolve the VIEWER's own Salesforce connection — the scoping boundary.
  const connection = await resolveSalesforceConnection(db, sessionUser.id);
  if (connection.status !== "ready") {
    await auditAppMutation({
      db,
      actorUserId: sessionUser.id,
      actionType: "app_data_refresh",
      appId: app.id,
      appSlug: app.slug,
      status: "succeeded",
      metadata: { bindingId, outcome: `connection_${connection.status}` },
    });
    // 200 with an honest connect state — the app renders a "Connect
    // Salesforce" prompt, never another viewer's data.
    return NextResponse.json(
      {
        ok: false,
        needsConnection: true,
        provider: binding.provider,
        connectionStatus: connection.status,
      },
      { status: 200, headers: DATA_JSON_HEADERS },
    );
  }

  try {
    const result = await queryReadOnlySoql(safeSoql, {
      accessToken: connection.accessToken,
      turnContext: buildSalesforceTurnContext({
        userId: sessionUser.id,
        instanceUrl: connection.instanceUrl,
      }),
    });
    await auditAppMutation({
      db,
      actorUserId: sessionUser.id,
      actionType: "app_data_refresh",
      appId: app.id,
      appSlug: app.slug,
      status: "succeeded",
      metadata: {
        bindingId,
        provider: binding.provider,
        rowCount: result.records.length,
      },
    });
    return NextResponse.json(
      {
        ok: true,
        bindingId: binding.id,
        provider: binding.provider,
        records: result.records,
        totalSize: result.totalSize,
        done: result.done,
      },
      { status: 200, headers: DATA_JSON_HEADERS },
    );
  } catch (err) {
    // NEVER surface the upstream error text: Salesforce INVALID_FIELD /
    // MALFORMED_QUERY messages echo the submitted query verbatim, and the
    // author's pinned SOQL must not reach a viewer's browser or the audit
    // row (cross-org field-level security makes this the common failure).
    // Only a status category survives.
    const upstreamStatus =
      err instanceof SalesforceApiError ? err.status : null;
    await auditAppMutation({
      db,
      actorUserId: sessionUser.id,
      actionType: "app_data_refresh",
      appId: app.id,
      appSlug: app.slug,
      status: "failed",
      error: upstreamStatus
        ? `salesforce_error_${upstreamStatus}`
        : "data_source_unreachable",
      metadata: { bindingId, provider: binding.provider },
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
}
