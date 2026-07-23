"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatDateTime } from "@/lib/format-date";

type TriggerKind = "pull_request_review" | "workflow_run_failure";

interface EventTriggerRow {
  id: string;
  repository: string;
  kind: TriggerKind | null;
  filters: {
    authorLogin?: string;
    assigneeLogin?: string;
  };
  threadMode: string;
  enabled: boolean;
  lastFiredAt: string | null;
  lastError: string | null;
}

interface EventTriggerPanelProps {
  skillId: string;
  triggers: EventTriggerRow[];
}

function describeKind(kind: TriggerKind | null): string {
  if (kind === "pull_request_review") return "Pull request review";
  if (kind === "workflow_run_failure") return "Failed CI run";
  return "GitHub event";
}

export function EventTriggerPanel({
  skillId,
  triggers,
}: EventTriggerPanelProps) {
  const router = useRouter();
  const [repository, setRepository] = useState("");
  const [kind, setKind] = useState<TriggerKind>("pull_request_review");
  const [authorLogin, setAuthorLogin] = useState("");
  const [assigneeLogin, setAssigneeLogin] = useState("");
  const [threadMode, setThreadMode] = useState<"dedicated" | "new">(
    "dedicated",
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inputClass =
    "rounded-md border border-hairline bg-canvas px-2 py-1.5 text-sm text-ink";

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setBusyId("create");
    setNotice(null);
    try {
      const response = await fetch("/api/event-triggers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          skillId,
          repository,
          kind,
          authorLogin: kind === "pull_request_review" ? authorLogin : undefined,
          assigneeLogin:
            kind === "pull_request_review" ? assigneeLogin : undefined,
          threadMode,
        }),
      });
      const body = (await response.json()) as {
        error?: string;
        message?: string;
      };
      if (!response.ok) {
        setNotice(body.message ?? body.error ?? "Could not add the trigger.");
        return;
      }
      setRepository("");
      setAuthorLogin("");
      setAssigneeLogin("");
      router.refresh();
    } catch {
      setNotice("Could not add the trigger.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleToggle(trigger: EventTriggerRow) {
    setBusyId(trigger.id);
    setNotice(null);
    try {
      const response = await fetch(`/api/event-triggers/${trigger.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !trigger.enabled }),
      });
      if (!response.ok) setNotice("Could not update the trigger.");
      router.refresh();
    } catch {
      setNotice("Could not update the trigger.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(trigger: EventTriggerRow) {
    if (!window.confirm("Delete this trigger? Past runs are kept.")) return;
    setBusyId(trigger.id);
    setNotice(null);
    try {
      const response = await fetch(`/api/event-triggers/${trigger.id}`, {
        method: "DELETE",
      });
      if (!response.ok) setNotice("Could not delete the trigger.");
      router.refresh();
    } catch {
      setNotice("Could not delete the trigger.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {triggers.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {triggers.map((trigger) => (
            <li
              key={trigger.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-hairline px-3 py-2 text-xs"
            >
              <span className="min-w-0 text-ink">
                <span className="font-medium">{trigger.repository}</span>
                <span className="text-muted">
                  {` · ${describeKind(trigger.kind)}`}
                  {trigger.filters.authorLogin
                    ? ` · author @${trigger.filters.authorLogin}`
                    : ""}
                  {trigger.filters.assigneeLogin
                    ? ` · assigned @${trigger.filters.assigneeLogin}`
                    : ""}
                  {!trigger.enabled ? " · paused" : ""}
                </span>
                {trigger.lastError ? (
                  <span className="block truncate text-muted">
                    Last error: {trigger.lastError}
                  </span>
                ) : null}
              </span>
              <span className="flex shrink-0 items-center gap-3">
                <span className="text-muted">
                  {trigger.lastFiredAt
                    ? `last ran ${formatDateTime(trigger.lastFiredAt)}`
                    : "not run yet"}
                </span>
                <button
                  type="button"
                  disabled={busyId === trigger.id}
                  className="text-ink hover:underline disabled:opacity-50"
                  onClick={() => handleToggle(trigger)}
                >
                  {trigger.enabled ? "Pause" : "Resume"}
                </button>
                <button
                  type="button"
                  disabled={busyId === trigger.id}
                  className="text-muted hover:text-ink disabled:opacity-50"
                  onClick={() => handleDelete(trigger)}
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted">No GitHub triggers yet.</p>
      )}

      <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Repository
          <input
            required
            value={repository}
            placeholder="owner/repository"
            className={`w-56 ${inputClass}`}
            onChange={(event) => setRepository(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Event
          <select
            value={kind}
            className={inputClass}
            onChange={(event) => setKind(event.target.value as TriggerKind)}
          >
            <option value="pull_request_review">Pull request review</option>
            <option value="workflow_run_failure">Failed CI run</option>
          </select>
        </label>
        {kind === "pull_request_review" ? (
          <>
            <label className="flex flex-col gap-1 text-xs text-muted">
              PR author
              <input
                value={authorLogin}
                placeholder="Any"
                className={`w-32 ${inputClass}`}
                onChange={(event) => setAuthorLogin(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted">
              PR assignee
              <input
                value={assigneeLogin}
                placeholder="Any"
                className={`w-32 ${inputClass}`}
                onChange={(event) => setAssigneeLogin(event.target.value)}
              />
            </label>
          </>
        ) : null}
        <label className="flex flex-col gap-1 text-xs text-muted">
          Results
          <select
            value={threadMode}
            className={inputClass}
            onChange={(event) =>
              setThreadMode(event.target.value as "dedicated" | "new")
            }
          >
            <option value="dedicated">One thread</option>
            <option value="new">New thread each time</option>
          </select>
        </label>
        <button
          type="submit"
          disabled={busyId !== null}
          className="rounded-md border border-hairline px-3 py-1.5 text-sm font-medium text-ink hover:bg-ink/5 disabled:opacity-50"
        >
          {busyId === "create" ? "Adding…" : "Add trigger"}
        </button>
      </form>
      {notice ? <p className="text-xs text-muted">{notice}</p> : null}
    </div>
  );
}
