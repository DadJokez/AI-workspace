import { auditLog, getDb, recipeRuns, users } from "@ai-workspace/db";
import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { MessageBubble } from "@/components/MessageBubble";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import type {
  PersistedToolCall,
  PersistedToolResult,
} from "@/lib/tool-events";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

interface RunOutput {
  briefingMarkdown?: string;
  toolCalls?: PersistedToolCall[];
  toolResults?: PersistedToolResult[];
  tokensIn?: number;
  tokensOut?: number;
  modelId?: string;
  runtime?: string;
}

export default async function AdminRunDetailPage({ params }: Props) {
  const sessionUser = await getSessionUser();
  if (!sessionUser || sessionUser.role !== "admin") {
    redirect("/chat");
  }

  const { id } = await params;
  const db = getDb();
  const rows = await db
    .select({
      id: recipeRuns.id,
      recipeSlug: recipeRuns.recipeSlug,
      status: recipeRuns.status,
      triggerType: recipeRuns.triggerType,
      runtime: recipeRuns.runtime,
      modelId: recipeRuns.modelId,
      inputs: recipeRuns.inputs,
      outputs: recipeRuns.outputs,
      error: recipeRuns.error,
      startedAt: recipeRuns.startedAt,
      completedAt: recipeRuns.completedAt,
      createdAt: recipeRuns.createdAt,
      updatedAt: recipeRuns.updatedAt,
      actorEmail: users.email,
      actorName: users.displayName,
    })
    .from(recipeRuns)
    .leftJoin(users, eq(recipeRuns.userId, users.id))
    .where(eq(recipeRuns.id, id))
    .limit(1);

  const run = rows[0];
  if (!run) notFound();

  const auditRows = await db
    .select({
      id: auditLog.id,
      actionType: auditLog.actionType,
      status: auditLog.status,
      provider: auditLog.provider,
      toolName: auditLog.toolName,
      toolCallId: auditLog.toolCallId,
      error: auditLog.error,
      startedAt: auditLog.startedAt,
      completedAt: auditLog.completedAt,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(eq(auditLog.recipeRunId, run.id))
    .orderBy(desc(auditLog.createdAt))
    .limit(100);

  const output = parseRunOutput(run.outputs);
  const prompt = parsePrompt(run.inputs);
  const toolCalls = output.toolCalls ?? [];
  const toolResults = output.toolResults ?? [];
  const tokenText =
    typeof output.tokensIn === "number" || typeof output.tokensOut === "number"
      ? `${output.tokensIn ?? 0} in / ${output.tokensOut ?? 0} out`
      : "n/a";

  return (
    <section className="py-2">
      <div className="px-6 pb-3 pt-4">
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
          <Link href="/admin/runs" className="hover:text-ink">
            Runs
          </Link>
          <span>/</span>
          <span className="font-mono">{shortId(run.id)}</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h2 className="text-base font-semibold text-ink">
            {formatRecipe(run.recipeSlug)}
          </h2>
          <StatusBadge status={run.status} />
        </div>
        <p className="mt-1 text-[12px] text-muted">
          Stored workflow output, tool activity, and audit trail for this run.
        </p>
      </div>

      <div className="grid gap-3 px-6 pb-5 md:grid-cols-4">
        <Metric label="Started" value={formatNullableDate(run.startedAt)} />
        <Metric
          label="Duration"
          value={
            run.startedAt && run.completedAt
              ? formatDuration(run.startedAt, run.completedAt)
              : run.startedAt
                ? "Running"
                : "Not started"
          }
        />
        <Metric label="Runtime" value={output.runtime ?? run.runtime ?? "n/a"} />
        <Metric label="Tokens" value={tokenText} />
      </div>

      <div className="grid gap-6 px-6 pb-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-6">
          {run.error ? (
            <section>
              <h3 className="mb-2 text-[13px] font-semibold text-ink">Error</h3>
              <div className="whitespace-pre-wrap rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2 font-mono text-[12px] text-red-300 [overflow-wrap:anywhere]">
                {run.error}
              </div>
            </section>
          ) : null}

          <section>
            <h3 className="mb-2 text-[13px] font-semibold text-ink">
              Briefing
            </h3>
            {output.briefingMarkdown ? (
              <div className="rounded-md border border-hairline bg-surface px-4 py-3">
                <MessageBubble
                  role="assistant"
                  content={output.briefingMarkdown}
                  modelId={output.modelId ?? run.modelId ?? undefined}
                  toolCalls={toolCalls}
                  toolResults={toolResults}
                />
              </div>
            ) : (
              <div className="rounded-md border border-hairline px-4 py-6 text-center text-[12px] text-muted">
                No briefing output was stored for this run.
              </div>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-[13px] font-semibold text-ink">
              Stored Tool Data
            </h3>
            <details className="rounded-md border border-hairline bg-surface px-3 py-2 text-[12px] text-muted">
              <summary className="cursor-pointer list-none marker:hidden">
                Redacted calls and results
              </summary>
              <pre className="mt-2 max-h-[28rem] overflow-auto border-t border-hairline pt-2 font-mono text-[11px] leading-relaxed text-ink [overflow-wrap:anywhere]">
                {JSON.stringify({ toolCalls, toolResults }, null, 2)}
              </pre>
            </details>
          </section>
        </div>

        <aside className="space-y-6">
          <section>
            <h3 className="mb-2 text-[13px] font-semibold text-ink">Run</h3>
            <dl className="divide-y divide-hairline rounded-md border border-hairline text-[12px]">
              <DetailRow
                label="User"
                value={run.actorName ?? run.actorEmail ?? "Unknown"}
              />
              <DetailRow label="Trigger" value={run.triggerType} />
              <DetailRow
                label="Model"
                value={output.modelId ?? run.modelId ?? "n/a"}
              />
              <DetailRow label="Created" value={formatDateTime(run.createdAt)} />
              <DetailRow label="Updated" value={formatDateTime(run.updatedAt)} />
            </dl>
          </section>

          <section>
            <h3 className="mb-2 text-[13px] font-semibold text-ink">Prompt</h3>
            <div className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-hairline bg-surface px-3 py-2 text-[12px] text-muted [overflow-wrap:anywhere]">
              {prompt ?? "No input prompt was stored."}
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-[13px] font-semibold text-ink">
              Audit Events
            </h3>
            <div className="rounded-md border border-hairline">
              {auditRows.length === 0 ? (
                <div className="px-3 py-6 text-center text-[12px] text-muted">
                  No audit events are linked to this run.
                </div>
              ) : (
                <div className="divide-y divide-hairline">
                  {auditRows.map((row) => (
                    <div key={row.id} className="px-3 py-2 text-[12px]">
                      <div className="flex items-center gap-2">
                        <StatusDot status={row.status} />
                        <span className="font-medium text-ink">
                          {formatAction(row.actionType)}
                        </span>
                        <span className="ml-auto text-muted">
                          {formatDateTime(row.createdAt)}
                        </span>
                      </div>
                      <div className="mt-1 font-mono text-[11px] text-muted">
                        {[row.provider, row.toolName]
                          .filter(Boolean)
                          .join(" / ") ||
                          "platform"}
                      </div>
                      {row.error ? (
                        <div className="mt-1 line-clamp-3 font-mono text-[11px] text-red-300">
                          {row.error}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}

function parseRunOutput(value: unknown): RunOutput {
  if (!isRecord(value)) return {};
  return {
    briefingMarkdown:
      typeof value.briefingMarkdown === "string"
        ? value.briefingMarkdown
        : undefined,
    toolCalls: Array.isArray(value.toolCalls)
      ? (value.toolCalls as PersistedToolCall[])
      : undefined,
    toolResults: Array.isArray(value.toolResults)
      ? (value.toolResults as PersistedToolResult[])
      : undefined,
    tokensIn: typeof value.tokensIn === "number" ? value.tokensIn : undefined,
    tokensOut: typeof value.tokensOut === "number" ? value.tokensOut : undefined,
    modelId: typeof value.modelId === "string" ? value.modelId : undefined,
    runtime: typeof value.runtime === "string" ? value.runtime : undefined,
  };
}

function parsePrompt(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.prompt === "string" ? value.prompt : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-hairline bg-surface px-3 py-2">
      <div className="text-[11px] uppercase tracking-wider text-muted">
        {label}
      </div>
      <div className="mt-1 truncate text-sm font-semibold text-ink">{value}</div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2 px-3 py-2">
      <dt className="text-muted">{label}</dt>
      <dd className="truncate text-ink">{value}</dd>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "succeeded"
      ? "bg-green-400"
      : status === "failed"
        ? "bg-red-400"
        : status === "running" || status === "started"
          ? "animate-pulse bg-blue-400"
          : status === "denied"
            ? "bg-yellow-400"
            : "bg-muted";
  return <span className={`h-2 w-2 shrink-0 rounded-full ${color}`} />;
}

function StatusBadge({ status }: { status: string }) {
  const classes =
    status === "succeeded"
      ? "bg-green-400/10 text-green-300"
      : status === "failed"
        ? "bg-red-400/10 text-red-300"
        : status === "running"
          ? "bg-blue-400/10 text-blue-300"
          : "bg-subtle text-muted";
  return (
    <span
      className={`inline-flex rounded px-2 py-0.5 text-[11px] uppercase tracking-wider ${classes}`}
    >
      {status}
    </span>
  );
}

function formatRecipe(value: string | null) {
  if (value === "developer-briefing") return "Developer Briefing";
  return value
    ? value
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ")
    : "Workflow run";
}

function formatAction(value: string) {
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function shortId(value: string) {
  return value.slice(0, 8);
}

function formatNullableDate(value: Date | null) {
  return value ? formatDateTime(value) : "n/a";
}

function formatDateTime(value: Date) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}

function formatDuration(startedAt: Date, completedAt: Date) {
  const ms = Math.max(0, completedAt.getTime() - startedAt.getTime());
  if (ms < 1_000) return `${ms}ms`;
  return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}
