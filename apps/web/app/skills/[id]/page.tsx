import {
  MODEL_IDS,
  PLATFORM_MODEL_OVERRIDE_ID,
} from "@ai-workspace/agent";
import { eventTriggers, getDb, runs, schedules, skills } from "@ai-workspace/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { formatDateTime } from "@/lib/format-date";
import { SUPPORTED_MCP_PROVIDERS } from "@/lib/oauth/mcp-servers";
import { modelDisplayName } from "@/lib/model-display";
import { SKILL_WEB_ACCESS_DECLARATION } from "@/lib/skill-tool-declarations";
import { canActorAccessSkill, listSharesForSubject } from "@/lib/shares";
import { eventTriggerKind } from "@/lib/github-event-triggers";
import { EventTriggerPanel } from "@/components/skills/EventTriggerPanel";
import { SchedulePanel } from "@/components/skills/SchedulePanel";
import { SharePanel } from "@/components/skills/SharePanel";
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
  if (!skill || !(await canActorAccessSkill(db, skill, sessionUser))) {
    notFound();
  }

  const isOwner = skill.ownerUserId === sessionUser.id;
  const effectiveModelId = PLATFORM_MODEL_OVERRIDE_ID ?? skill.modelId;
  const skillShares = isOwner
    ? await listSharesForSubject(db, "skill", skill.id)
    : [];
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
  const myEventTriggers = await db
    .select()
    .from(eventTriggers)
    .where(
      and(
        eq(eventTriggers.skillId, skill.id),
        eq(eventTriggers.userId, sessionUser.id),
        isNull(eventTriggers.deletedAt),
      ),
    )
    .orderBy(desc(eventTriggers.createdAt));
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
    .where(
      and(eq(runs.skillId, skill.id), eq(runs.userId, sessionUser.id)),
    )
    .orderBy(desc(runs.createdAt))
    .limit(20);

  return (
    <section className="px-6 py-6">
      <div className="pb-4">
        <Link href="/skills" className="text-xs text-muted hover:text-ink">
          ← Back to catalog
        </Link>
        <div className="mt-2 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-ink">{skill.name}</h2>
            <p className="mt-1 text-xs text-muted">
              {skill.description ?? "No description."}
            </p>
            <p className="mt-1 text-2xs text-muted">
              {modelDisplayName(effectiveModelId)}
              {skill.mcpProviders.length > 0
                ? ` · tools: ${skill.mcpProviders.join(", ")}`
                : " · no tools"}
              {skill.isStarter ? " · starter" : ""}
              {skill.archivedAt ? " · archived" : ""}
            </p>
          </div>
          {!skill.archivedAt ? (
            <div className="flex items-center gap-3">
              <a
                href={`/api/skills/${skill.id}/export`}
                className="text-xs text-muted hover:text-ink"
                title="Download as a portable SKILL.md"
              >
                Export
              </a>
              <SkillActions skillId={skill.id} isOwner={isOwner} showArchive />
            </div>
          ) : null}
        </div>
      </div>

      {isOwner && !skill.archivedAt ? (
        <div className="border-t border-hairline pt-5">
          <h3 className="pb-3 text-xs font-medium uppercase tracking-wider text-muted">
            Edit
          </h3>
          <SkillForm
            mode="edit"
            skillId={skill.id}
            modelOptions={
              PLATFORM_MODEL_OVERRIDE_ID
                ? [PLATFORM_MODEL_OVERRIDE_ID]
                : [...MODEL_IDS]
            }
            providerOptions={[
              ...SUPPORTED_MCP_PROVIDERS,
              SKILL_WEB_ACCESS_DECLARATION,
            ]}
            initial={{
              name: skill.name,
              description: skill.description ?? "",
              systemPrompt: skill.systemPrompt,
              modelId: effectiveModelId,
              mcpProviders: skill.mcpProviders,
            }}
          />
        </div>
      ) : (
        <div className="border-t border-hairline pt-5">
          <h3 className="pb-2 text-xs font-medium uppercase tracking-wider text-muted">
            Instructions
          </h3>
          <pre className="whitespace-pre-wrap rounded-lg border border-hairline p-4 text-xs text-ink">
            {skill.systemPrompt}
          </pre>
          <p className="mt-2 text-xs text-muted">
            Clone this skill to make your own editable copy.
          </p>
        </div>
      )}

      {!skill.archivedAt ? (
        <div className="mt-6 border-t border-hairline pt-5">
          <h3 className="pb-2 text-xs font-medium uppercase tracking-wider text-muted">
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

      {!skill.archivedAt ? (
        <div className="mt-6 border-t border-hairline pt-5">
          <h3 className="pb-2 text-xs font-medium uppercase tracking-wider text-muted">
            GitHub triggers
          </h3>
          <EventTriggerPanel
            skillId={skill.id}
            triggers={myEventTriggers.map((trigger) => ({
              id: trigger.id,
              repository: trigger.repository,
              kind: eventTriggerKind(trigger),
              filters: trigger.filters as {
                authorLogin?: string;
                assigneeLogin?: string;
              },
              threadMode: trigger.threadMode,
              enabled: trigger.enabled,
              lastFiredAt: trigger.lastFiredAt?.toISOString() ?? null,
              lastError: trigger.lastError,
            }))}
          />
        </div>
      ) : null}

      {isOwner && !skill.archivedAt ? (
        <div className="mt-6 border-t border-hairline pt-5">
          <h3 className="pb-2 text-xs font-medium uppercase tracking-wider text-muted">
            Sharing
          </h3>
          <SharePanel
            subjectType="skill"
            subjectId={skill.id}
            shares={skillShares.map((share) => ({
              id: share.id,
              grantedToEmail: share.grantedToEmail,
              grantedToName: share.grantedToName,
            }))}
          />
        </div>
      ) : null}

      <div className="mt-6 border-t border-hairline pt-5">
        <h3 className="pb-2 text-xs font-medium uppercase tracking-wider text-muted">
          Recent runs
        </h3>
        {history.length === 0 ? (
          <p className="text-xs text-muted">No runs yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {history.map((run) => {
              const statusPresentation = runStatusPresentation(run.status);
              return (
                <li
                  key={run.id}
                  className="flex flex-col items-start justify-between gap-2 rounded-md border border-hairline px-3 py-2 text-xs sm:flex-row sm:gap-4"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        aria-hidden="true"
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusPresentation.dotClass}`}
                      />
                      <span className="font-medium text-ink">
                        {statusPresentation.label}
                      </span>
                      <span className="text-muted">
                        {runTriggerLabel(run.triggerType)}
                      </span>
                    </div>
                    {run.error ? (
                      <p className="mt-1 break-words text-danger">
                        {run.error}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <time
                      className="text-muted"
                      dateTime={run.createdAt.toISOString()}
                    >
                      {formatDateTime(run.createdAt)}
                    </time>
                    {run.threadId ? (
                      <Link
                        href={`/chat?threadId=${run.threadId}`}
                        className="text-ink hover:underline"
                      >
                        Open thread
                      </Link>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

const RUN_STATUS_PRESENTATION: Record<
  string,
  { label: string; dotClass: string }
> = {
  queued: { label: "Queued", dotClass: "bg-muted" },
  running: { label: "Running", dotClass: "bg-info" },
  succeeded: { label: "Succeeded", dotClass: "bg-success" },
  failed: { label: "Failed", dotClass: "bg-danger" },
  canceled: { label: "Canceled", dotClass: "bg-muted" },
};

function runStatusPresentation(status: string) {
  return (
    RUN_STATUS_PRESENTATION[status] ?? {
      label: "Unknown",
      dotClass: "bg-muted",
    }
  );
}

function runTriggerLabel(triggerType: string): string {
  const labels: Record<string, string> = {
    skill: "Manual run",
    scheduled: "Scheduled run",
    github_event: "GitHub event",
  };
  return labels[triggerType] ?? "Skill run";
}
