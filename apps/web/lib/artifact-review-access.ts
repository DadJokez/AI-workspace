import type { SessionUser } from "@ai-workspace/auth";
import {
  appVersions,
  apps,
  type App,
  type AppVersion,
  type Database,
  type WorkspaceArtifact,
  workspaceArtifacts,
} from "@ai-workspace/db";
import { and, asc, eq } from "drizzle-orm";
import {
  canListAppVersionForActor,
  resolveAppActorRole,
  type AppActorRole,
} from "@/lib/apps";
import {
  buildWorkspaceArtifactVersionSet,
  loadWorkspaceArtifactById,
  type WorkspaceArtifactVersionSet,
} from "@/lib/workspace-artifacts";

export interface ArtifactReviewAccess {
  artifact: WorkspaceArtifact;
  role: "owner" | AppActorRole;
  canComment: boolean;
  canAddress: boolean;
  app: App | null;
  appVersion: AppVersion | null;
}

/**
 * Resolve an artifact through its owner or a visible app version. The app
 * version check is important: an app share must not expose another editor's
 * private draft merely because both artifacts belong to the same app.
 */
export async function resolveArtifactReviewAccess({
  db,
  actor,
  artifactId,
}: {
  db: Database;
  actor: Pick<SessionUser, "id" | "role">;
  artifactId: string;
}): Promise<ArtifactReviewAccess | null> {
  const artifact = await loadWorkspaceArtifactById({ db, artifactId });
  if (!artifact) return null;
  if (artifact.userId === actor.id) {
    return {
      artifact,
      role: "owner",
      canComment: true,
      canAddress: true,
      app: null,
      appVersion: null,
    };
  }

  const linked = await db
    .select({ app: apps, version: appVersions })
    .from(appVersions)
    .innerJoin(apps, eq(appVersions.appId, apps.id))
    .where(eq(appVersions.artifactId, artifact.id));

  let best: ArtifactReviewAccess | null = null;
  for (const row of linked) {
    const role = await resolveAppActorRole(db, row.app, actor);
    if (role === "none") continue;
    if (
      !canListAppVersionForActor(row.version, {
        actorRole: role,
        visibleToUserId: actor.id,
      })
    ) {
      continue;
    }
    const candidate: ArtifactReviewAccess = {
      artifact,
      role,
      canComment: true,
      // Shared reviewers can leave feedback. Creating a replacement artifact
      // remains owner-scoped until app-edit sessions can pin this exact base.
      canAddress: false,
      app: row.app,
      appVersion: row.version,
    };
    if (!best || accessRank(candidate.role) > accessRank(best.role)) {
      best = candidate;
    }
  }
  return best;
}

export async function loadArtifactVersionsForReview({
  db,
  actor,
  artifactId,
}: {
  db: Database;
  actor: Pick<SessionUser, "id" | "role">;
  artifactId: string;
}): Promise<WorkspaceArtifactVersionSet | null> {
  const selectedAccess = await resolveArtifactReviewAccess({
    db,
    actor,
    artifactId,
  });
  if (!selectedAccess) return null;

  const rows = await db
    .select()
    .from(workspaceArtifacts)
    .where(
      and(
        eq(
          workspaceArtifacts.userId,
          selectedAccess.artifact.userId,
        ),
        eq(
          workspaceArtifacts.artifactGroupId,
          selectedAccess.artifact.artifactGroupId,
        ),
      ),
    )
    .orderBy(
      asc(workspaceArtifacts.versionNumber),
      asc(workspaceArtifacts.createdAt),
    );

  const visible = selectedAccess.role === "owner"
    ? rows
    : (
        await Promise.all(
          rows.map(async (row) => ({
            row,
            access: await resolveArtifactReviewAccess({
              db,
              actor,
              artifactId: row.id,
            }),
          })),
        )
      )
        .filter((entry) => entry.access)
        .map((entry) => entry.row);
  return buildWorkspaceArtifactVersionSet(selectedAccess.artifact, visible);
}

function accessRank(role: ArtifactReviewAccess["role"]): number {
  if (role === "owner") return 5;
  if (role === "admin") return 4;
  if (role === "editor") return 3;
  if (role === "viewer") return 2;
  return 0;
}
