/**
 * Browser-reported timezone handling for chat date grounding (#432).
 *
 * Interactive chat turns send `Intl.DateTimeFormat().resolvedOptions().timeZone`
 * from the browser so the model can resolve "today"/"tomorrow" in the user's
 * local zone. The value is untrusted request input that ends up inside a
 * system prompt, so every consumer (web route, queued-run worker, AgentCore
 * container) must pass it through `normalizeUserTimeZone` first: anything
 * that is not a real IANA zone is treated as absent, never echoed.
 */

/**
 * Longest real IANA identifier is ~32 chars ("America/Argentina/ComodRivadavia");
 * 64 leaves headroom without letting a hostile client ship a paragraph.
 */
const MAX_TIME_ZONE_CHARS = 64;

let canonicalTimeZones: Set<string> | undefined;

function supportedTimeZones(): Set<string> {
  if (!canonicalTimeZones) {
    canonicalTimeZones = new Set(Intl.supportedValuesOf("timeZone"));
    // Browsers on UTC systems report plain "UTC", which V8 omits from
    // supportedValuesOf. It is a valid zone; accept it explicitly.
    canonicalTimeZones.add("UTC");
  }
  return canonicalTimeZones;
}

/**
 * Validate an untrusted timezone string against the runtime's IANA database.
 * Returns the canonical identifier (case normalized, aliases resolved) or
 * `undefined` — absent and invalid are deliberately indistinguishable so
 * callers fail closed to the UTC-only prompt wording.
 */
export function normalizeUserTimeZone(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (!raw || raw.length > MAX_TIME_ZONE_CHARS) return undefined;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: raw })
      .resolvedOptions()
      .timeZone;
  } catch {
    // Not a timezone at all ("'; DROP TABLE runs;--", random garbage).
    return undefined;
  }
  // The constructor probe also accepts bare offsets ("+05:30"); the canonical
  // membership check keeps only real IANA zone names.
  return supportedTimeZones().has(resolved) ? resolved : undefined;
}

/**
 * The per-turn clock statement for the system prompt's volatile suffix.
 *
 * Without a zone this is byte-identical to the historical UTC-only line — the
 * prompt honestly says only UTC is known instead of silently treating UTC as
 * local. With a validated zone it adds the user's local date/time so relative
 * dates resolve in their zone, while an explicit timezone named by the user
 * still wins. An invalid zone (belt and braces — callers normalize first)
 * degrades to the UTC-only statement rather than throwing mid-turn.
 */
export function renderClockStatement(now: Date, userTimeZone?: string): string {
  const iso = now.toISOString();
  const localLine = userTimeZone
    ? renderUserLocalLine(now, userTimeZone)
    : undefined;
  if (localLine) {
    return [`Current date and time (UTC): ${iso}.`, localLine].join("\n");
  }
  return `Current date and time (UTC): ${iso}. Treat this as ground truth for any date or time reasoning; the user's local timezone may differ.`;
}

function renderUserLocalLine(now: Date, timeZone: string): string | undefined {
  let local: string;
  try {
    local = new Intl.DateTimeFormat("en-US", {
      timeZone,
      dateStyle: "full",
      timeStyle: "short",
    }).format(now);
  } catch {
    return undefined;
  }
  return `Current date and time for the user (${timeZone}): ${local}. Treat these as ground truth and resolve relative dates and times — "today", "tomorrow", weekday names, clock times — in this timezone, unless the user names a different timezone, which then wins.`;
}
