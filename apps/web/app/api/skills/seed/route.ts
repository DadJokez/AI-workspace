import { getDb, skills } from "@ai-workspace/db";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { DEVELOPER_BRIEFING_SKILL_SLUG } from "@/lib/developer-briefing";
import { auditSkillMutation } from "@/lib/skills";

export const dynamic = "force-dynamic";

const STARTERS = [
  {
    slug: DEVELOPER_BRIEFING_SKILL_SLUG,
    name: "Developer Briefing",
    description:
      "A focused summary of your open pull requests, review requests, and CI status across your GitHub repositories.",
    systemPrompt: [
      "Produce a developer briefing for the current user from their GitHub account.",
      "",
      "1. List open pull requests they authored — title, repo, age, review state, and CI status.",
      "2. List pull requests waiting on their review.",
      "3. Flag anything stalled for more than three days or failing CI.",
      "4. Close with a short 'suggested next actions' list, most urgent first.",
      "",
      "Keep it compact and skimmable. Use the GitHub tools to read real data — never invent repositories, pull requests, or statuses.",
    ].join("\n"),
    modelId: "sonnet-4-6",
    mcpProviders: ["github"],
  },
  {
    slug: "weekly-status",
    name: "Weekly Status",
    description:
      "Drafts a week-in-review status update from your GitHub activity: what shipped, what's in flight, what's blocked.",
    systemPrompt: [
      "Draft the user's weekly status update from their GitHub activity over the past 7 days.",
      "",
      "Sections: Shipped (merged PRs), In flight (open PRs with state), Blocked / needs attention (stalled reviews, failing CI).",
      "Write it in first person, ready to paste into a status thread. Use the GitHub tools to read real data — never invent activity.",
    ].join("\n"),
    modelId: "sonnet-4-6",
    mcpProviders: ["github"],
  },
];

/**
 * Idempotent admin action: seed the starter skills (T207). Existing slugs
 * are left untouched so re-running is always safe.
 */
export async function POST() {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (sessionUser.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const db = getDb();
  const created: string[] = [];
  const skipped: string[] = [];

  for (const starter of STARTERS) {
    const existing = await db
      .select({ id: skills.id })
      .from(skills)
      .where(eq(skills.slug, starter.slug))
      .limit(1);
    if (existing[0]) {
      skipped.push(starter.slug);
      continue;
    }

    const rows = await db
      .insert(skills)
      .values({
        slug: starter.slug,
        name: starter.name,
        description: starter.description,
        ownerUserId: sessionUser.id,
        systemPrompt: starter.systemPrompt,
        modelId: starter.modelId,
        mcpProviders: starter.mcpProviders,
        isStarter: true,
      })
      .onConflictDoNothing({ target: skills.slug })
      .returning({ id: skills.id, slug: skills.slug });

    if (rows[0]) {
      created.push(rows[0].slug);
      await auditSkillMutation({
        db,
        actorUserId: sessionUser.id,
        actionType: "skill_seed",
        skillId: rows[0].id,
        skillSlug: rows[0].slug,
      });
    } else {
      skipped.push(starter.slug);
    }
  }

  return NextResponse.json({ created, skipped });
}
