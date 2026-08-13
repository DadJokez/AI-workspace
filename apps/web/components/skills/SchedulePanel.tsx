"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { AsyncStatusNotice } from "@/components/AsyncStatusNotice";
import { DestructiveConfirmDialog } from "@/components/DestructiveConfirmDialog";
import { fetchJson } from "@/lib/client-api";
import { formatDateTime } from "@/lib/format-date";

interface ScheduleRow {
  id: string;
  cadence: string;
  timezone: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string;
  lastError: string | null;
  targetThreadId: string | null;
}

interface SchedulePanelProps {
  skillId: string;
  schedules: ScheduleRow[];
}

type Preset = "daily" | "weekdays" | "weekly" | "monthly";

const DOW_OPTIONS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

function buildCadence(
  preset: Preset,
  time: string,
  weekday: string,
  monthDay: number,
): string {
  const [hRaw, mRaw] = time.split(":");
  const hour = Number.parseInt(hRaw ?? "8", 10);
  const minute = Number.parseInt(mRaw ?? "0", 10);
  switch (preset) {
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * MON-FRI`;
    case "weekly":
      return `${minute} ${hour} * * ${weekday}`;
    case "monthly":
      return `${minute} ${hour} ${monthDay} * *`;
  }
}

function describeCadence(cadence: string, timezone: string): string {
  const fields = cadence.split(/\s+/);
  if (fields.length !== 5) return cadence;
  const [m, h, dom, , dow] = fields as [string, string, string, string, string];
  const time = `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
  if (dom !== "*") return `Monthly on day ${dom} at ${time} (${timezone})`;
  if (dow === "*") return `Daily at ${time} (${timezone})`;
  if (dow === "MON-FRI") return `Weekdays at ${time} (${timezone})`;
  return `Weekly on ${dow} at ${time} (${timezone})`;
}

export function SchedulePanel({ skillId, schedules }: SchedulePanelProps) {
  const router = useRouter();
  const [preset, setPreset] = useState<Preset>("weekly");
  const [time, setTime] = useState("08:00");
  const [weekday, setWeekday] = useState("MON");
  const [monthDay, setMonthDay] = useState(1);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ScheduleRow | null>(null);

  const timezone =
    Intl.DateTimeFormat().resolvedOptions().timeZone ?? "America/New_York";

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      await fetchJson(
        "/api/schedules",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            skillId,
            cadence: buildCadence(preset, time, weekday, monthDay),
            timezone,
          }),
        },
        "Could not create the schedule.",
      );
      router.refresh();
    } catch (err) {
      setNotice(
        err instanceof Error ? err.message : "Could not create the schedule.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleToggle(schedule: ScheduleRow) {
    setBusy(true);
    setNotice(null);
    try {
      await fetchJson(
        `/api/schedules/${schedule.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: !schedule.enabled }),
        },
        "Could not update the schedule.",
      );
      router.refresh();
    } catch (err) {
      setNotice(
        err instanceof Error ? err.message : "Could not update the schedule.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(schedule: ScheduleRow) {
    setBusy(true);
    setNotice(null);
    try {
      await fetchJson(
        `/api/schedules/${schedule.id}`,
        { method: "DELETE" },
        "Could not delete the schedule.",
      );
      setPendingDelete(null);
      router.refresh();
    } catch (err) {
      setNotice(
        err instanceof Error ? err.message : "Could not delete the schedule.",
      );
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    "rounded-md border border-hairline bg-canvas px-2 py-1.5 text-sm text-ink";

  return (
    <div className="flex flex-col gap-3">
      {schedules.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {schedules.map((schedule) => (
            <li
              key={schedule.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-hairline px-3 py-2 text-xs"
            >
              <span className="text-ink">
                {describeCadence(schedule.cadence, schedule.timezone)}
                {!schedule.enabled ? (
                  <span className="text-muted"> · paused</span>
                ) : null}
                {schedule.lastError ? (
                  <span className="text-danger">
                    {" "}
                    · last error: {schedule.lastError.slice(0, 60)}
                  </span>
                ) : null}
              </span>
              <span className="flex items-center gap-3">
                <span className="text-muted">
                  next {formatDateTime(schedule.nextRunAt)}
                </span>
                <button
                  type="button"
                  className="text-ink hover:underline"
                  onClick={() => handleToggle(schedule)}
                >
                  {schedule.enabled ? "Pause" : "Resume"}
                </button>
                <button
                  type="button"
                  className="text-danger hover:underline"
                  onClick={() => {
                    setNotice(null);
                    setPendingDelete(schedule);
                  }}
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted">
          No schedules yet. Results arrive in a dedicated thread without you
          asking.
        </p>
      )}

      <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Repeats
          <select
            className={inputClass}
            value={preset}
            onChange={(e) => setPreset(e.target.value as Preset)}
          >
            <option value="daily">Daily</option>
            <option value="weekdays">Weekdays</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </label>
        {preset === "weekly" ? (
          <label className="flex flex-col gap-1 text-xs text-muted">
            Day
            <select
              className={inputClass}
              value={weekday}
              onChange={(e) => setWeekday(e.target.value)}
            >
              {DOW_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {preset === "monthly" ? (
          <label className="flex flex-col gap-1 text-xs text-muted">
            Day of month
            <input
              type="number"
              min={1}
              max={28}
              className={`w-20 ${inputClass}`}
              value={monthDay}
              onChange={(e) =>
                setMonthDay(
                  Math.min(28, Math.max(1, Number.parseInt(e.target.value || "1", 10))),
                )
              }
            />
          </label>
        ) : null}
        <label className="flex flex-col gap-1 text-xs text-muted">
          At
          <input
            type="time"
            className={inputClass}
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
        </label>
        <span className="pb-2 text-2xs text-muted">{timezone}</span>
        <button
          type="submit"
          disabled={busy}
          className="rounded-md border border-hairline px-3 py-1.5 text-sm font-medium text-ink hover:bg-ink/5 disabled:opacity-50"
        >
          {busy ? "Scheduling…" : "Add schedule"}
        </button>
      </form>
      <AsyncStatusNotice message={pendingDelete ? null : notice} />
      <DestructiveConfirmDialog
        open={pendingDelete !== null}
        title="Delete schedule?"
        description={
          pendingDelete
            ? `${describeCadence(pendingDelete.cadence, pendingDelete.timezone)} will stop running. Past runs will be kept.`
            : "Past runs will be kept."
        }
        actionLabel="Delete"
        errorMessage={notice}
        busy={busy && pendingDelete !== null}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) void handleDelete(pendingDelete);
        }}
      />
    </div>
  );
}
