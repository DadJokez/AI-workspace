export interface MessageTimestamp {
  label: string;
  iso: string;
}

interface FormatMessageTimestampOptions {
  locale?: string;
  timeZone?: string;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export function formatMessageTimestamp(
  createdAt: string | Date | undefined,
  nowMs: number,
  options: FormatMessageTimestampOptions = {},
): MessageTimestamp | null {
  if (!createdAt) return null;
  const date = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;

  const now = new Date(nowMs);
  const elapsed = now.getTime() - date.getTime();
  if (elapsed >= 0 && elapsed < MINUTE_MS) {
    return { label: "Just now", iso: date.toISOString() };
  }
  if (elapsed >= MINUTE_MS && elapsed < HOUR_MS) {
    return {
      label: `${Math.floor(elapsed / MINUTE_MS)} min ago`,
      iso: date.toISOString(),
    };
  }

  const locale = options.locale;
  const timeZone = options.timeZone;
  if (calendarKey(date, timeZone) === calendarKey(now, timeZone)) {
    return {
      label: new Intl.DateTimeFormat(locale, {
        hour: "numeric",
        minute: "2-digit",
        ...(timeZone ? { timeZone } : {}),
      }).format(date),
      iso: date.toISOString(),
    };
  }

  const sameYear = yearInZone(date, timeZone) === yearInZone(now, timeZone);
  return {
    label: new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      ...(!sameYear ? { year: "numeric" as const } : {}),
      ...(timeZone ? { timeZone } : {}),
    }).format(date),
    iso: date.toISOString(),
  };
}

function calendarKey(date: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

function yearInZone(date: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}
