/**
 * DST-safe next-occurrence computation for the schedule cadence subset
 * (specs/002-skills-spine T300). Zero dependencies — wall-clock times in the
 * schedule's IANA zone are resolved to instants with Intl.
 *
 * Supported cadence grammar (5-field cron subset, validated strictly):
 *   "M H * * *"        every day at H:M
 *   "M H * * MON"      weekly on a day (SUN..SAT or 0..6)
 *   "M H * * MON-FRI"  weekdays (any day range)
 *   "M H D * *"        monthly on day-of-month D (1..28 to stay valid in
 *                      every month)
 *
 * "8am Monday" stays 8am local across DST transitions. For wall-clock times
 * that do not exist on a spring-forward day (e.g. 02:30 in America/New_York
 * on the transition date), the occurrence resolves to the post-shift instant
 * the clock actually reaches.
 */

const DOW_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;

export interface ParsedCadence {
  minute: number;
  hour: number;
  /** null = any day of month */
  dayOfMonth: number | null;
  /** null = any weekday; otherwise allowed JS weekday numbers (0=Sun). */
  daysOfWeek: number[] | null;
}

export function parseCadence(cadence: string): ParsedCadence {
  const fields = cadence.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Cadence must have 5 fields ("M H DOM MON DOW"); got "${cadence}".`,
    );
  }
  const [minuteRaw, hourRaw, domRaw, monthRaw, dowRaw] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  const minute = parseIntInRange(minuteRaw, 0, 59, "minute");
  const hour = parseIntInRange(hourRaw, 0, 23, "hour");

  if (monthRaw !== "*") {
    throw new Error("Month field must be '*' (month cadences are not supported).");
  }

  let dayOfMonth: number | null = null;
  if (domRaw !== "*") {
    dayOfMonth = parseIntInRange(domRaw, 1, 28, "day-of-month");
  }

  let daysOfWeek: number[] | null = null;
  if (dowRaw !== "*") {
    if (dayOfMonth !== null) {
      throw new Error("Use day-of-month or day-of-week, not both.");
    }
    daysOfWeek = parseDowField(dowRaw);
  }

  return { minute, hour, dayOfMonth, daysOfWeek };
}

export function isValidCadence(cadence: string): boolean {
  try {
    parseCadence(cadence);
    return true;
  } catch {
    return false;
  }
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * First instant strictly after `after` matching the cadence in `timezone`.
 */
export function computeNextRunAt(
  cadence: string,
  timezone: string,
  after: Date,
): Date {
  const parsed = parseCadence(cadence);
  if (!isValidTimezone(timezone)) {
    throw new Error(`Unknown timezone "${timezone}".`);
  }

  // Walk forward day by day in the zone's calendar starting from the zone's
  // "today" for `after`. 370 days covers every supported cadence.
  const startParts = getZoneParts(after, timezone);
  for (let offset = 0; offset < 370; offset++) {
    const day = addDays(
      { year: startParts.year, month: startParts.month, day: startParts.day },
      offset,
    );
    if (parsed.dayOfMonth !== null && day.day !== parsed.dayOfMonth) continue;
    if (parsed.daysOfWeek !== null) {
      const dow = weekdayOf(day);
      if (!parsed.daysOfWeek.includes(dow)) continue;
    }

    const instant = zonedWallTimeToInstant(
      day.year,
      day.month,
      day.day,
      parsed.hour,
      parsed.minute,
      timezone,
    );
    if (instant.getTime() > after.getTime()) return instant;
  }
  throw new Error(`No occurrence found within a year for "${cadence}".`);
}

/* ── internals ─────────────────────────────────────────────────────── */

interface CalendarDay {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

function parseIntInRange(
  raw: string,
  min: number,
  max: number,
  label: string,
): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid ${label} "${raw}".`);
  }
  const value = Number.parseInt(raw, 10);
  if (value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}; got ${value}.`);
  }
  return value;
}

function parseDowToken(token: string): number {
  const upper = token.toUpperCase();
  const named = DOW_NAMES.indexOf(upper as (typeof DOW_NAMES)[number]);
  if (named >= 0) return named;
  if (/^\d$/.test(token)) {
    const n = Number.parseInt(token, 10);
    if (n >= 0 && n <= 7) return n % 7; // cron allows 7 = Sunday
  }
  throw new Error(`Invalid day-of-week "${token}".`);
}

function parseDowField(raw: string): number[] {
  if (raw.includes("-")) {
    const [fromRaw, toRaw] = raw.split("-");
    if (!fromRaw || !toRaw) throw new Error(`Invalid day-of-week range "${raw}".`);
    const from = parseDowToken(fromRaw);
    const to = parseDowToken(toRaw);
    const days: number[] = [];
    let d = from;
    for (let i = 0; i < 7; i++) {
      days.push(d);
      if (d === to) return days;
      d = (d + 1) % 7;
    }
    return days;
  }
  return [parseDowToken(raw)];
}

function addDays(start: CalendarDay, days: number): CalendarDay {
  // Date.UTC arithmetic on a pure calendar — no zone involvement.
  const utc = new Date(Date.UTC(start.year, start.month - 1, start.day + days));
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
  };
}

function weekdayOf(day: CalendarDay): number {
  return new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
}

interface ZoneParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partFormatters = new Map<string, Intl.DateTimeFormat>();

function getZonePartsFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = partFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partFormatters.set(timeZone, fmt);
  }
  return fmt;
}

function getZoneParts(date: Date, timeZone: string): ZoneParts {
  const parts = getZonePartsFormatter(timeZone).formatToParts(date);
  const get = (type: string) =>
    Number.parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24, // h23 still yields "24" for midnight in some ICU versions
    minute: get("minute"),
    second: get("second"),
  };
}

/** Offset (ms) of `timeZone` from UTC at `date` (positive east of UTC). */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const p = getZoneParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - date.getTime();
}

/**
 * Resolve a wall-clock time in a zone to an instant. Two-pass offset
 * estimation handles DST: repeated times (fall back) resolve to the first
 * occurrence; nonexistent times (spring forward) resolve to the shifted
 * instant the clock actually reaches.
 */
function zonedWallTimeToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const wallUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const firstOffset = zoneOffsetMs(new Date(wallUtc), timeZone);
  let instant = wallUtc - firstOffset;
  const secondOffset = zoneOffsetMs(new Date(instant), timeZone);
  if (secondOffset !== firstOffset) {
    // The two estimates straddle a transition. The second estimate is right
    // when the requested wall time actually exists there (normal/fall-back
    // case); in a spring-forward gap it undershoots into the pre-transition
    // hour, so keep the first estimate — the post-shift instant the clock
    // actually reaches.
    const candidate = wallUtc - secondOffset;
    const parts = getZoneParts(new Date(candidate), timeZone);
    if (parts.day === day && parts.hour === hour && parts.minute === minute) {
      instant = candidate;
    }
  }
  return new Date(instant);
}
