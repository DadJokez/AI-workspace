/**
 * Pure helpers for the admin Usage dashboard. The dashboard aggregates the
 * existing `runs` ledger (every chat turn + skill/workflow execution) over a
 * trailing window — no separate `usage_events` table needed. Kept dependency-
 * free so the window math and the dense day-series fill are unit-testable apart
 * from the server component that renders them.
 */

export type UsageWindow = "7d" | "30d" | "90d";

export const USAGE_WINDOWS: readonly UsageWindow[] = ["7d", "30d", "90d"];

const WINDOW_DAYS: Record<UsageWindow, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

export function parseUsageWindow(value: unknown): UsageWindow {
  const single = Array.isArray(value) ? value[0] : value;
  return single === "7d" || single === "30d" || single === "90d"
    ? single
    : "30d";
}

export function windowDays(window: UsageWindow): number {
  return WINDOW_DAYS[window];
}

/** UTC midnight (ms) of the day `date` falls in. */
function startOfUtcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

const DAY_MS = 86_400_000;

/**
 * Inclusive lower bound for the window: UTC midnight of the oldest day shown.
 * A 7d window covers today plus the previous six days, so the SQL filter and
 * the rendered bars cover exactly the same span.
 */
export function windowSince(window: UsageWindow, now: Date): Date {
  const today = startOfUtcDay(now);
  return new Date(today - (windowDays(window) - 1) * DAY_MS);
}

export interface DayCount {
  /** UTC calendar day, `YYYY-MM-DD`. */
  day: string;
  count: number;
}

/**
 * Densify sparse per-day counts into one entry per day across the window,
 * oldest → newest, zero-filling days with no runs. Days are UTC, matching the
 * `YYYY-MM-DD` keys the SQL query emits via `date_trunc(... 'UTC')`.
 */
export function buildDaySeries(
  counts: readonly DayCount[],
  window: UsageWindow,
  now: Date,
): DayCount[] {
  const byDay = new Map(counts.map((c) => [c.day, c.count]));
  const today = startOfUtcDay(now);
  const days = windowDays(window);
  const series: DayCount[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = new Date(today - i * DAY_MS).toISOString().slice(0, 10);
    series.push({ day: key, count: byDay.get(key) ?? 0 });
  }
  return series;
}

/** Whole-number percent of `value` over `total`, guarding divide-by-zero. */
export function percent(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((value / total) * 100);
}
