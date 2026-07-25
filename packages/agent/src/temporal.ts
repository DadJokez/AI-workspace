/**
 * Deterministic relative-date resolution (#646).
 *
 * The clock statement (`timezone.ts`) tells the model what "now" is but leaves
 * the calendar arithmetic for "next Tuesday" to generation — which is exactly
 * where weekday slips came from (a relative "Friday" rendered as "Saturday,
 * August 1"). This module resolves the common unambiguous relative references
 * in a user message to exact local dates so the loop can hand the model data
 * instead of homework.
 *
 * Reading "today" via Intl is the only timezone-sensitive step. All calendar
 * arithmetic happens on UTC-noon date objects built from the user's local
 * calendar date: UTC has no DST, so whole-day steps can never land inside a
 * spring-forward gap or a fall-back repeat.
 */

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/**
 * The full resolvable vocabulary. Because matches are constrained to these
 * fixed words, no free-form user text can flow through `sourceText` into the
 * prompt line the loop injects. Ambiguous phrases ("next weekend", "next
 * week") deliberately do not match and stay unresolved.
 */
const RELATIVE_REFERENCE_RE =
  /\b(?:(today|tonight|tomorrow|yesterday)|(?:(this|next)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/gi;

export interface ResolvedDateReference {
  /** The matched phrase, lowercased with collapsed spaces ("next tuesday"). */
  sourceText: string;
  /** Resolved local calendar date, ISO YYYY-MM-DD. */
  isoDate: string;
  /** Weekday name of `isoDate` ("Tuesday"). */
  weekday: string;
}

/**
 * The user's local calendar date at `now`, as a UTC-noon Date suitable for
 * whole-day arithmetic. Undefined when the zone cannot be formatted — callers
 * must pass `normalizeUserTimeZone` output, so this is belt and braces that
 * degrades to "no resolution" rather than throwing mid-turn.
 */
function localCalendarDate(now: Date, timeZone: string): Date | undefined {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
  } catch {
    return undefined;
  }
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  const year = read("year");
  const month = read("month");
  const day = read("day");
  if (![year, month, day].every(Number.isFinite)) return undefined;
  return new Date(Date.UTC(year, month - 1, day, 12));
}

/**
 * Scan `text` for relative date references and resolve each against the fixed
 * clock `now` in the user's `timeZone`. Pure: same inputs, same output.
 *
 * Semantics:
 * - today / tonight = the local calendar date at `now`; tomorrow = +1 local
 *   day; yesterday = −1.
 * - "this <weekday>" = that weekday within the current ISO week (Mon–Sun),
 *   even when it is already past — "this Monday" said on a Saturday is the
 *   Monday five days ago.
 * - "next <weekday>" = that weekday in the following ISO week, even when
 *   today is that weekday ("next Tuesday" on a Tuesday is a week out).
 * - bare weekday = the nearest occurrence on or after today (today counts).
 *
 * Duplicate phrases resolve once; results keep first-appearance order.
 */
export function resolveRelativeDateReferences(
  text: string,
  now: Date,
  timeZone: string,
): ResolvedDateReference[] {
  const today = localCalendarDate(now, timeZone);
  if (!today) return [];
  const todayIso = isoWeekday(today);
  // Days from today back to the current ISO week's Monday.
  const mondayOffset = 1 - todayIso;
  const seen = new Set<string>();
  const resolved: ResolvedDateReference[] = [];
  for (const match of text.matchAll(RELATIVE_REFERENCE_RE)) {
    const sourceText = match[0].toLowerCase().replace(/\s+/g, " ");
    if (seen.has(sourceText)) continue;
    seen.add(sourceText);
    const [, fixedWord, qualifier, weekdayName] = match;
    let dayDelta: number;
    if (fixedWord) {
      const word = fixedWord.toLowerCase();
      dayDelta = word === "tomorrow" ? 1 : word === "yesterday" ? -1 : 0;
    } else {
      const targetIso = isoWeekdayFromName(weekdayName!);
      const qualifierWord = qualifier?.toLowerCase();
      if (qualifierWord === "this") {
        dayDelta = mondayOffset + (targetIso - 1);
      } else if (qualifierWord === "next") {
        dayDelta = mondayOffset + 7 + (targetIso - 1);
      } else {
        dayDelta = (targetIso - todayIso + 7) % 7;
      }
    }
    const date = new Date(today.getTime() + dayDelta * 86_400_000);
    resolved.push({
      sourceText,
      isoDate: date.toISOString().slice(0, 10),
      weekday: WEEKDAYS[date.getUTCDay()]!,
    });
  }
  return resolved;
}

/** ISO weekday (Monday=1 … Sunday=7) of a UTC-noon calendar date. */
function isoWeekday(date: Date): number {
  const dow = date.getUTCDay();
  return dow === 0 ? 7 : dow;
}

function isoWeekdayFromName(name: string): number {
  const index = WEEKDAYS.findIndex(
    (weekday) => weekday.toLowerCase() === name.toLowerCase(),
  );
  return index === 0 ? 7 : index;
}

/**
 * The compact prompt line the loop injects next to the clock statement, e.g.
 * "Resolved date references: 'next tuesday' = 2026-07-28 (Tuesday)." —
 * grounding data for the model, not an instruction. Undefined when there is
 * nothing to resolve, so no line is emitted at all.
 */
export function renderResolvedDateReferences(
  references: readonly ResolvedDateReference[],
): string | undefined {
  if (references.length === 0) return undefined;
  const entries = references.map(
    (ref) => `'${ref.sourceText}' = ${ref.isoDate} (${ref.weekday})`,
  );
  return `Resolved date references: ${entries.join(", ")}.`;
}
