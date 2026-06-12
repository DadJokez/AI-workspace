import { MODEL_IDS } from "@ai-workspace/agent";
import { getDb, runs, schedules, skills } from "@ai-workspace/db";
import { and, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { SUPPORTED_MCP_PROVIDERS } from "@/lib/oauth/mcp-servers";
import { canViewSkill } from "@/lib/skills";
import { SchedulePanel } from "@/components/skills/SchedulePanel";
import { SkillActions } from "@/components/skills/SkillActions";
import { SkillForm } from "@/components/skills/SkillForm";

export const dynamic = "force-dynamic";

export default async function SkillDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const sessionUser = (await getSessionUser())!; // layout redirects when null
  const { id } = await params;

  const db = getDb();
  const rows = await db.select().from(skills).where(eq(skills.id, id)).limit(1);
  const skill = rows[0];
  if (!skill || !canViewSkill(skill, sessionUser)) notFound();

  const isOwner = skill.ownerUserId === sessionUser.id;
  const mySchedules = await db
    .select()
    .from(schedules)
    .where(
      and(
        eq(schedules.skillId, skill.id),
        eq(schedules.userId, sessionUser.id),
      ),
    )
    .orderBy(desc(schedules.createdAt));
  const history = await db
    .select({
      id: runs.id,
      status: runs.status,
      triggerType: runs.triggerType,
      threadId: runs.threadId,
      error: runs.error,
      createdAt: runs.createdAt,
      completedAt: runs.completedAt,
    })
    .from(runs)
    .where(eq(runs.skillId, skill.id))
    .orderBy(desc(runs.createdAt))
    .limit(20);

  return (
    <section className="px-6 py-6">
      <div className="pb-4">
        <Link href="/skills" className="text-[12px] text-muted hover:text-ink">
          ← Back to catalog
        </Link>
        <div className="mt-2 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-ink">{skill.name}</h2>
            <p className="mt-1 text-[12px] text-muted">
              {skill.description ?? "No description."}
            </p>
            <p className="mt-1 text-[11px] text-muted">
              {skill.modelId}
              {skill.mcpProviders.length > 0
                ? ` · tools: ${skill.mcpProviders.join(", ")}`
                : " · no tools"}
              {skill.isStarter ? " · starter" : ""}
              {skill.archivedAt ? " · archived" : ""}
            </p>
          </div>
          {!skill.archivedAt ? (
            <SkillActions skillId={skill.id} isOwner={isOwner} showArchive />
          ) : null}
        </div>
      </div>

      {isOwner && !skill.archivedAt ? (
        <div className="border-t border-hairline pt-5">
          <h3 className="pb-3 text-[12px] font-medium uppercase tracking-wider text-muted">
            Edit
          </h3>
          <SkillForm
            mode="edit"
            skillId={skill.id}
            modelOptions={[...MODEL_IDS]}
            providerOptions={SUPPORTED_MCP_PROVIDERS}
            initial={{
              name: skill.name,
              description: skill.description ?? "",
              systemPrompt: skill.systemPrompt,
              modelId: skill.modelId,
              mcpProviders: skill.mcpProviders,
            }}
          />
        </div>
      ) : (
        <div className="border-t border-hairline pt-5">
          <h3 className="pb-2 text-[12px] font-medium uppercase tracking-wider text-muted">
            Instructions
          </h3>
          <pre className="whitespace-pre-wrap rounded-lg border border-hairline p-4 text-[12px] text-ink">
            {skill.systemPrompt}
          </pre>
          <p className="mt-2 text-[12px] text-muted">
            Clone this skill to make your own editable copy.
          </p>
        </div>
      )}

      {!skill.archivedAt ? (
        <div className="mt-6 border-t border-hairline pt-5">
          <h3 className="pb-2 text-[12px] font-medium uppercase tracking-wider text-muted">
            Schedule
          </h3>
          <SchedulePanel
            skillId={skill.id}
            schedules={mySchedules.map((s) => ({
              id: s.id,
              cadence: s.cadence,
              timezone: s.timezone,
              enabled: s.enabled,
              lastRunAt: s.lastRunAt?.toISOString() ?? null,
              nextRunAt: s.nextRunAt.toISOString(),
              lastError: s.lastError,
              targetThreadId: s.targetThreadId,
            }))}
          />
        </div>
      ) : null}

      <div className="mt-6 border-t border-hairline pt-5">
        <h3 className="pb-2 text-[12px] font-medium uppercase tracking-wider text-muted">
          Recent runs
        </h3>
        {history.length === 0 ? (
          <p className="text-[12px] text-muted">No runs yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {history.map((run) => (
              <li
                key={run.id}
                className="flex items-center justify-between rounded-md border border-hairline px-3 py-2 text-[12px]"
              >
                <span className="text-ink">
                  {run.status}
                  <span className="text-muted"> · {run.triggerType}</span>
                  {run.error ? (
                    <span className="text-muted"> · {run.error.slice(0, 80)}</span>
                  ) : null}
                </span>
                <span className="flex items-center gap-3">
                  <span className="text-muted">
                    {run.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                  </span>
                  {run.threadId ? (
                    <Link
                      href={`/chat?threadId=${run.threadId}`}
                      className="text-ink hover:underline"
                    >
                      Open thread
                    </Link>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
