import {
  appEditSessions,
  appVersions,
  apps,
  feedbackReports,
  getDb,
  rateLimitBuckets,
  shares,
  skills,
  users,
  workspaceArtifacts,
} from "@ai-workspace/db";
import { eq, inArray, like } from "drizzle-orm";

const smokeUserId = "00000000-0000-4000-8000-000000000203";
const starterOwnerId = "00000000-0000-4000-8000-000000000204";
const sharedOwnerId = "00000000-0000-4000-8000-000000000205";
const appRecipientId = "00000000-0000-4000-8000-000000000206";
const ownedSkillId = "00000000-0000-4000-8000-000000000213";
const starterSkillId = "00000000-0000-4000-8000-000000000214";
const sharedSkillId = "00000000-0000-4000-8000-000000000215";
const appId = "00000000-0000-4000-8000-000000000230";
const liveArtifactId = "00000000-0000-4000-8000-000000000231";
const previousArtifactId = "00000000-0000-4000-8000-000000000232";
const draftArtifactId = "00000000-0000-4000-8000-000000000233";
const discardArtifactId = "00000000-0000-4000-8000-000000000234";
const liveVersionId = "00000000-0000-4000-8000-000000000241";
const previousVersionId = "00000000-0000-4000-8000-000000000242";
const draftVersionId = "00000000-0000-4000-8000-000000000243";
const discardVersionId = "00000000-0000-4000-8000-000000000244";
const triagedFeedbackId = "00000000-0000-4000-8000-000000000251";
const fixedFeedbackId = "00000000-0000-4000-8000-000000000252";
const resolvedFeedbackId = "00000000-0000-4000-8000-000000000253";
const fixtureUserIds = [
  smokeUserId,
  starterOwnerId,
  sharedOwnerId,
  appRecipientId,
];
const fixtureSkillIds = [ownedSkillId, starterSkillId, sharedSkillId];
const fixtureAppIds = [appId];
const fixtureArtifactIds = [
  liveArtifactId,
  previousArtifactId,
  draftArtifactId,
  discardArtifactId,
];

async function main() {
  const db = getDb();

  await db
    .delete(rateLimitBuckets)
    .where(eq(rateLimitBuckets.bucketKey, `invite-email:${smokeUserId}`));
  // Magic-link request buckets from previous smoke runs (the per-email cap
  // and the email:ip dimension) — without this, repeated local runs inside
  // one window trip the limiter.
  await db
    .delete(rateLimitBuckets)
    .where(like(rateLimitBuckets.bucketKey, "magic-link%"));
  await db
    .delete(shares)
    .where(inArray(shares.subjectId, [...fixtureSkillIds, ...fixtureAppIds]));
  await db.delete(appEditSessions).where(inArray(appEditSessions.appId, fixtureAppIds));
  await db.delete(appVersions).where(inArray(appVersions.appId, fixtureAppIds));
  await db.delete(apps).where(inArray(apps.id, fixtureAppIds));
  await db
    .delete(workspaceArtifacts)
    .where(inArray(workspaceArtifacts.id, fixtureArtifactIds));
  await db.delete(skills).where(inArray(skills.id, fixtureSkillIds));
  await db.delete(users).where(inArray(users.id, fixtureUserIds));

  await db.insert(users).values([
    {
      id: smokeUserId,
      pingSubject: "auth-smoke-github-subject",
      email: "auth-smoke@example.com",
      displayName: "Auth Smoke",
      role: "admin",
      defaultModelId: "sonnet-4-5",
      assistantName: "Thomas",
      tourCompletedAt: new Date(),
    },
    {
      id: starterOwnerId,
      pingSubject: "auth-smoke-starter-owner",
      email: "starter-owner@example.com",
      displayName: "Starter Owner",
      role: "admin",
    },
    {
      id: sharedOwnerId,
      pingSubject: "auth-smoke-shared-owner",
      email: "shared-owner@example.com",
      displayName: "Shared Owner",
      role: "user",
    },
    {
      id: appRecipientId,
      pingSubject: "auth-smoke-app-recipient",
      email: "app-recipient@example.com",
      displayName: "App Recipient",
      role: "user",
    },
  ]);

  await db.insert(feedbackReports).values([
    {
      id: triagedFeedbackId,
      userId: smokeUserId,
      type: "bug",
      severity: "normal",
      status: "triaged",
      title: "Auth Smoke Triaged Feedback",
      body: "A seeded triaged report for feedback navigation coverage.",
    },
    {
      id: fixedFeedbackId,
      userId: smokeUserId,
      type: "enhancement",
      severity: "low",
      status: "fixed",
      title: "Auth Smoke Fixed Feedback",
      body: "A seeded fixed report for feedback navigation coverage.",
    },
    {
      id: resolvedFeedbackId,
      userId: smokeUserId,
      type: "bug",
      severity: "normal",
      status: "resolved",
      title: "Auth Smoke Legacy Resolved Feedback",
      body: "A legacy resolved report that must remain discoverable as fixed.",
      resolvedAt: new Date(),
    },
  ]);

  await db.insert(skills).values([
    {
      id: ownedSkillId,
      slug: "auth-smoke-weekly-status",
      name: "Auth Smoke Weekly Status",
      description: "Drafts a weekly update from product notes.",
      ownerUserId: smokeUserId,
      systemPrompt: "Draft a concise weekly update.",
      modelId: "sonnet-4-5",
      mcpProviders: [],
      isStarter: false,
    },
    {
      id: starterSkillId,
      slug: "auth-smoke-starter-brief",
      name: "Auth Smoke Starter Brief",
      description: "Starter skill for concise executive briefs.",
      ownerUserId: starterOwnerId,
      systemPrompt: "Write an executive brief.",
      modelId: "sonnet-4-5",
      mcpProviders: [],
      isStarter: true,
    },
    {
      id: sharedSkillId,
      slug: "auth-smoke-shared-review",
      name: "Auth Smoke Shared Review",
      description: "Shared skill for reviewing launch notes.",
      ownerUserId: sharedOwnerId,
      systemPrompt: "Review launch notes for risks.",
      modelId: "sonnet-4-5",
      mcpProviders: ["github"],
      isStarter: false,
    },
  ]);

  await db.insert(shares).values({
    subjectType: "skill",
    subjectId: sharedSkillId,
    grantedToUserId: smokeUserId,
    grantedByUserId: sharedOwnerId,
  });

  await db.insert(workspaceArtifacts).values([
    appArtifact({
      id: previousArtifactId,
      title: "Auth Smoke Previous App",
      filename: "auth-smoke-v1.html",
      content:
        "<!doctype html><html><body><h1>Auth Smoke Previous</h1></body></html>",
      versionNumber: 1,
    }),
    appArtifact({
      id: liveArtifactId,
      title: "Auth Smoke Live App",
      filename: "auth-smoke-v2.html",
      content:
        "<!doctype html><html><body><h1>Auth Smoke Live</h1></body></html>",
      versionNumber: 2,
    }),
    appArtifact({
      id: draftArtifactId,
      title: "Auth Smoke Draft App",
      filename: "auth-smoke-v3.html",
      content:
        "<!doctype html><html><body><h1>Auth Smoke Draft</h1></body></html>",
      versionNumber: 3,
      versionSummary: "Ready to deploy from smoke.",
    }),
    appArtifact({
      id: discardArtifactId,
      title: "Auth Smoke Throwaway Draft",
      filename: "auth-smoke-v4.html",
      content:
        "<!doctype html><html><body><h1>Auth Smoke Throwaway</h1></body></html>",
      versionNumber: 4,
      versionSummary: "Smoke should discard this draft.",
    }),
  ]);

  await db.insert(apps).values({
    id: appId,
    ownerUserId: smokeUserId,
    slug: "auth-smoke-app",
    name: "Auth Smoke App",
    description: "Seeded app for lifecycle smoke coverage.",
    liveArtifactId,
    status: "deployed",
  });

  await db.insert(appVersions).values([
    {
      id: previousVersionId,
      appId,
      artifactId: previousArtifactId,
      versionNumber: 1,
      status: "reverted",
      summary: "Previous live version.",
      createdByUserId: smokeUserId,
      deployedAt: new Date(Date.now() - 60_000),
    },
    {
      id: liveVersionId,
      appId,
      artifactId: liveArtifactId,
      versionNumber: 2,
      status: "deployed",
      summary: "Current live version.",
      createdByUserId: smokeUserId,
      deployedAt: new Date(),
    },
    {
      id: draftVersionId,
      appId,
      artifactId: draftArtifactId,
      versionNumber: 3,
      status: "draft",
      summary: "Ready to deploy from smoke.",
      createdByUserId: smokeUserId,
    },
    {
      id: discardVersionId,
      appId,
      artifactId: discardArtifactId,
      versionNumber: 4,
      status: "draft",
      summary: "Smoke should discard this draft.",
      createdByUserId: smokeUserId,
    },
  ]);

  await db
    .update(apps)
    .set({ liveVersionId })
    .where(inArray(apps.id, fixtureAppIds));

  await db.insert(shares).values({
    subjectType: "app",
    subjectId: appId,
    grantedToUserId: appRecipientId,
    grantedByUserId: smokeUserId,
    role: "viewer",
  });

  console.log("auth smoke fixtures seeded");
  process.exit(0);
}

function appArtifact({
  id,
  title,
  filename,
  content,
  versionNumber,
  versionSummary = null,
}: {
  id: string;
  title: string;
  filename: string;
  content: string;
  versionNumber: number;
  versionSummary?: string | null;
}) {
  return {
    id,
    userId: smokeUserId,
    title,
    filename,
    artifactGroupId: previousArtifactId,
    versionNumber,
    versionSummary,
    kind: "html",
    mimeType: "text/html",
    content,
    sizeBytes: Buffer.byteLength(content),
    source: "assistant",
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
