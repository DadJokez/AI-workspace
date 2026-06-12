import type { SessionUser } from "@ai-workspace/auth";
import {
  type App,
  apps,
  auditLog,
  type Database,
  shares,
  type WorkspaceArtifact,
  workspaceArtifacts,
} from "@ai-workspace/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { hasActiveShare } from "@/lib/shares";
import { slugifySkillName, suffixedSkillSlug } from "@/lib/skills";

/**
 * Thin apps (J4 slice, specs/002-skills-spine US5): an app is a registry row
 * over workspace artifacts. "Deploy" pins `live_artifact_id`; "Save draft"
 * is implicit (every chat iteration stores a new artifact version); revert
 * repins an older version. Apps serve at /apps/{slug} behind workspace auth
 * with a restrictive CSP — no git, pipelines, or per-app AWS services here.
 */

/** Static segments under /apps that can never be app slugs. */
export const RESERVED_APP_SLUGS = new Set(["manage", "new", "api"]);

const NAME_MAX = 120;
const DESCRIPTION_MAX = 2_000;

export interface AppInput {
  name: string;
  description: string | null;
}

export function parseAppInput(
  value: unknown,
):
  | { ok: true; input: AppInput }
  | { ok: false; error: { field: string; message: string } } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      error: { field: "body", message: "Request body must be a JSON object." },
    };
  }
  const body = value as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > NAME_MAX) {
    return {
      ok: false,
      error: {
        field: "name",
        message: `Name is required and must be at most ${NAME_MAX} characters.`,
      },
    };
  }
  const description =
    typeof body.description === "string" && body.description.trim()
      ? body.description.trim().slice(0, DESCRIPTION_MAX)
      : null;
  return { ok: true, input: { name, description } };
}

/**
 * Pure visibility predicate: owners and admins always; archived apps stay
 * visible to them so history links keep working. Share grants are layered on
 * by `canActorAccessApp`.
 */
export function canViewApp(
  app: Pick<App, "ownerUserId" | "archivedAt">,
  actor: Pick<SessionUser, "id" | "role">,
): boolean {
  return app.ownerUserId === actor.id || actor.role === "admin";
}

/** Async visibility check including shares; shares never bypass archival. */
export async function canActorAccessApp(
  db: Database,
  app: Pick<App, "id" | "ownerUserId" | "archivedAt">,
  actor: Pick<SessionUser, "id" | "role">,
): Promise<boolean> {
  if (canViewApp(app, actor)) return true;
  if (app.archivedAt) return false;
  return hasActiveShare(db, "app", app.id, actor.id);
}

/** Openable = accessible, deployed, and pointing at a live artifact. */
export async function canActorOpenApp(
  db: Database,
  app: Pick<App, "id" | "ownerUserId" | "archivedAt" | "status" | "liveArtifactId">,
  actor: Pick<SessionUser, "id" | "role">,
): Promise<boolean> {
  if (app.archivedAt) return false;
  if (app.status !== "deployed" || !app.liveArtifactId) return false;
  return canActorAccessApp(db, app, actor);
}

/** Apps shared with a user (active grants, unarchived apps). */
export async function listAppsSharedWith(
  db: Database,
  userId: string,
): Promise<App[]> {
  const rows = await db
    .select({ app: apps })
    .from(shares)
    .innerJoin(apps, eq(shares.subjectId, apps.id))
    .where(
      and(
        eq(shares.subjectType, "app"),
        eq(shares.grantedToUserId, userId),
        isNull(shares.revokedAt),
        isNull(apps.archivedAt),
      ),
    )
    .orderBy(desc(shares.createdAt));
  return rows.map((row) => row.app);
}

/**
 * FR-014: the no-secrets policy applies to app content at save time. Scans
 * for the same credential shapes the tool-redaction layer knows, as
 * substrings anywhere in the document. Returns human-readable labels of what
 * was found; empty array = clean.
 */
export function findCredentialShapedContent(text: string): string[] {
  const findings: string[] = [];
  const checks: Array<[RegExp, string]> = [
    [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/, "a GitHub token"],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/, "a GitHub fine-grained token"],
    [/\bsk-[A-Za-z0-9_-]{20,}\b/, "an API secret key"],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key block"],
    [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key id"],
    [/\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/i, "a bearer token"],
    [
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
      "a JWT",
    ],
  ];
  for (const [pattern, label] of checks) {
    if (pattern.test(text)) findings.push(label);
  }
  return findings;
}

/** v1 serves self-contained HTML documents only. */
export function isServableArtifact(
  artifact: Pick<WorkspaceArtifact, "mimeType" | "filename">,
): boolean {
  return (
    artifact.mimeType === "text/html" ||
    artifact.filename.toLowerCase().endsWith(".html")
  );
}

/**
 * Deployable version candidates for an app: the owner's HTML artifacts from
 * the thread the app was built in, newest first.
 */
export async function listAppVersionCandidates(
  db: Database,
  {
    ownerUserId,
    sourceThreadId,
    limit = 25,
  }: { ownerUserId: string; sourceThreadId: string | null; limit?: number },
): Promise<WorkspaceArtifact[]> {
  if (!sourceThreadId) return [];
  const rows = await db
    .select()
    .from(workspaceArtifacts)
    .where(
      and(
        eq(workspaceArtifacts.userId, ownerUserId),
        eq(workspaceArtifacts.threadId, sourceThreadId),
      ),
    )
    .orderBy(desc(workspaceArtifacts.createdAt))
    .limit(Math.max(1, Math.min(100, limit)));
  return rows.filter(isServableArtifact);
}

/** Insert an app, retrying with a suffixed slug on collision/reservation. */
export async function insertAppWithUniqueSlug(
  db: Database,
  values: Omit<typeof apps.$inferInsert, "slug"> & { slug?: string },
): Promise<App> {
  let base = values.slug ?? slugifySkillName(values.name);
  if (RESERVED_APP_SLUGS.has(base)) base = suffixedSkillSlug(base);
  for (const candidate of [
    base,
    suffixedSkillSlug(base),
    suffixedSkillSlug(base),
  ]) {
    const rows = await db
      .insert(apps)
      .values({ ...values, slug: candidate })
      .onConflictDoNothing({ target: apps.slug })
      .returning();
    if (rows[0]) return rows[0];
  }
  throw new Error("Could not allocate a unique app slug.");
}

export async function auditAppMutation({
  db,
  actorUserId,
  actionType,
  appId,
  appSlug,
  metadata,
}: {
  db: Database;
  actorUserId: string;
  actionType:
    | "app_register"
    | "app_update"
    | "app_deploy"
    | "app_revert"
    | "app_archive";
  appId: string;
  appSlug: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const now = new Date();
  await db.insert(auditLog).values({
    actorUserId,
    actionType,
    status: "succeeded",
    provider: "ai-hub",
    toolName: appSlug,
    input: { appId, appSlug },
    metadata: metadata ?? null,
    startedAt: now,
    completedAt: now,
  });
}
