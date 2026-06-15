import { getDb, shares, skills, users } from "@ai-workspace/db";
import { inArray } from "drizzle-orm";

const smokeUserId = "00000000-0000-4000-8000-000000000203";
const starterOwnerId = "00000000-0000-4000-8000-000000000204";
const sharedOwnerId = "00000000-0000-4000-8000-000000000205";
const ownedSkillId = "00000000-0000-4000-8000-000000000213";
const starterSkillId = "00000000-0000-4000-8000-000000000214";
const sharedSkillId = "00000000-0000-4000-8000-000000000215";
const fixtureUserIds = [smokeUserId, starterOwnerId, sharedOwnerId];
const fixtureSkillIds = [ownedSkillId, starterSkillId, sharedSkillId];

async function main() {
  const db = getDb();

  await db.delete(shares).where(inArray(shares.subjectId, fixtureSkillIds));
  await db.delete(skills).where(inArray(skills.id, fixtureSkillIds));
  await db.delete(users).where(inArray(users.id, fixtureUserIds));

  await db.insert(users).values([
    {
      id: smokeUserId,
      pingSubject: "auth-smoke-github-subject",
      email: "auth-smoke@example.com",
      displayName: "Auth Smoke",
      role: "admin",
      defaultModelId: "sonnet-4-6",
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
  ]);

  await db.insert(skills).values([
    {
      id: ownedSkillId,
      slug: "auth-smoke-weekly-status",
      name: "Auth Smoke Weekly Status",
      description: "Drafts a weekly update from product notes.",
      ownerUserId: smokeUserId,
      systemPrompt: "Draft a concise weekly update.",
      modelId: "sonnet-4-6",
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
      modelId: "sonnet-4-6",
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
      modelId: "sonnet-4-6",
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

  console.log("auth smoke fixtures seeded");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
