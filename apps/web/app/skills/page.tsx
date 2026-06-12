import { getDb, skills } from "@ai-workspace/db";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import Link from "next/link";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { SkillActions } from "@/components/skills/SkillActions";
import { SeedStartersButton } from "@/components/skills/SeedStartersButton";

export const dynamic = "force-dynamic";

export default async function SkillsPage() {
  const sessionUser = (await getSessionUser())!; // layout redirects when null

  const db = getDb();
  const rows = await db
    .select()
    .from(skills)
    .where(
      and(
        isNull(skills.archivedAt),
        or(eq(skills.ownerUserId, sessionUser.id), eq(skills.isStarter, true)),
      ),
    )
    .orderBy(desc(skills.updatedAt));

  const mine = rows.filter((s) => s.ownerUserId === sessionUser.id);
  const starters = rows.filter(
    (s) => s.isStarter && s.ownerUserId !== sessionUser.id,
  );

  return (
    <section className="px-6 py-6">
      <div className="flex items-center justify-between pb-4">
        <div>
          <h2 className="text-base font-semibold text-ink">Skill catalog</h2>
          <p className="mt-1 text-[12px] text-muted">
            Saved agent definitions you can run, clone, and (soon) schedule
            and share.
          </p>
        </div>
        <Link
          href="/skills/new"
          className="rounded-md border border-hairline px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-ink/5"
        >
          New skill
        </Link>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-hairline px-4 py-6 text-center">
          <p className="text-[13px] text-muted">
            No skills yet. Create one, or seed the starter skills.
          </p>
          {sessionUser.role === "admin" ? (
            <div className="mt-3 flex justify-center">
              <SeedStartersButton />
            </div>
          ) : null}
        </div>
      ) : null}

      {mine.length > 0 ? (
        <SkillGroup title="Your skills" skillRows={mine} isOwner />
      ) : null}
      {starters.length > 0 ? (
        <SkillGroup title="Starters" skillRows={starters} isOwner={false} />
      ) : null}
    </section>
  );
}

function SkillGroup({
  title,
  skillRows,
  isOwner,
}: {
  title: string;
  skillRows: (typeof skills.$inferSelect)[];
  isOwner: boolean;
}) {
  return (
    <div className="pb-6">
      <h3 className="pb-2 text-[12px] font-medium uppercase tracking-wider text-muted">
        {title}
      </h3>
      <div className="grid gap-3 md:grid-cols-2">
        {skillRows.map((skill) => (
          <div
            key={skill.id}
            className="flex flex-col gap-2 rounded-lg border border-hairline p-4"
          >
            <div className="flex items-start justify-between gap-2">
              <Link
                href={`/skills/${skill.id}`}
                className="text-[14px] font-medium text-ink hover:underline"
              >
                {skill.name}
              </Link>
              {skill.isStarter ? (
                <span className="rounded-full border border-hairline px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted">
                  Starter
                </span>
              ) : null}
            </div>
            {skill.description ? (
              <p className="text-[12px] text-muted">{skill.description}</p>
            ) : null}
            <p className="text-[11px] text-muted">
              {skill.modelId}
              {skill.mcpProviders.length > 0
                ? ` · tools: ${skill.mcpProviders.join(", ")}`
                : " · no tools"}
            </p>
            <SkillActions skillId={skill.id} isOwner={isOwner} />
          </div>
        ))}
      </div>
    </div>
  );
}
