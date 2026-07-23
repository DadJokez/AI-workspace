import { AuthConfigError, UnauthorizedError } from "@ai-workspace/auth";
import {
  appVersions,
  auditLog,
  getDb,
  workspaceArtifacts,
} from "@ai-workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import {
  decideOutputProposalMetadata,
  normalizeProposalReason,
} from "@/lib/output-proposals";
import {
  loadWorkspaceArtifactForUser,
  serializeWorkspaceArtifact,
  serializeWorkspaceArtifactDetail,
} from "@/lib/workspace-artifacts";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const sessionUser = await getSessionUser();
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const artifact = await loadWorkspaceArtifactForUser({
      db: getDb(),
      userId: sessionUser.id,
      artifactId: id,
    });
    if (!artifact) {
      return NextResponse.json({ error: "artifact_not_found" }, { status: 404 });
    }

    return NextResponse.json({
      artifact: serializeWorkspaceArtifactDetail(artifact),
    });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (err instanceof AuthConfigError) {
      return NextResponse.json(
        { error: "auth_config_error", message: err.message },
        { status: 500 },
      );
    }
    throw err;
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const decision = (body as Record<string, unknown> | null)?.decision;
  if (decision !== "accepted" && decision !== "discarded") {
    return NextResponse.json({ error: "invalid_decision" }, { status: 400 });
  }
  const reason = normalizeProposalReason(
    (body as Record<string, unknown> | null)?.reason,
  );
  const db = getDb();
  const artifact = await loadWorkspaceArtifactForUser({
    db,
    userId: sessionUser.id,
    artifactId: id,
  });
  if (!artifact) {
    return NextResponse.json({ error: "artifact_not_found" }, { status: 404 });
  }
  const appVersion = await db
    .select({ id: appVersions.id })
    .from(appVersions)
    .where(
      and(
        eq(appVersions.artifactId, artifact.id),
        eq(appVersions.status, "proposed"),
      ),
    )
    .limit(1);
  if (appVersion[0]) {
    return NextResponse.json(
      {
        error: "app_proposal",
        message: "Review this proposal from its app version card.",
      },
      { status: 409 },
    );
  }

  const now = new Date();
  const metadata = decideOutputProposalMetadata({
    metadata: artifact.metadata,
    decision,
    decidedAt: now,
    decidedByUserId: sessionUser.id,
    reason,
  });
  if (!metadata) {
    return NextResponse.json(
      { error: "proposal_not_pending" },
      { status: 409 },
    );
  }

  const updated = await db.transaction(async (tx) => {
    const rows = await tx
      .update(workspaceArtifacts)
      .set({ metadata, updatedAt: now })
      .where(
        and(
          eq(workspaceArtifacts.id, artifact.id),
          eq(workspaceArtifacts.userId, sessionUser.id),
          sql`${workspaceArtifacts.metadata}->'outputProposal'->>'status' = 'proposed'`,
        ),
      )
      .returning();
    if (!rows[0]) return null;
    await tx.insert(auditLog).values({
      actorUserId: sessionUser.id,
      actionType:
        decision === "accepted" ? "proposal_accepted" : "proposal_discarded",
      status: "succeeded",
      provider: "ai-hub",
      toolName: "workspace_artifact_proposal",
      chatThreadId: artifact.threadId,
      chatMessageId: artifact.chatMessageId,
      runId: artifact.runId,
      input: { artifactId: artifact.id },
      metadata: {
        subjectType: "workspace_artifact",
        filename: artifact.filename,
        ...(reason ? { reason } : {}),
      },
      startedAt: now,
      completedAt: now,
    });
    return rows[0];
  });
  if (!updated) {
    return NextResponse.json(
      { error: "proposal_not_pending" },
      { status: 409 },
    );
  }
  return NextResponse.json({ artifact: serializeWorkspaceArtifact(updated) });
}
