import type { EvalSuite } from "../types";

const CURRENT_YEAR = new Date().getFullYear();
const STALE_TRAINING_YEARS = ["2023", "2024", "2025"];

/**
 * Capability A — temporal grounding (the Christmas class).
 *
 * The bug that birthed this harness: "is it christmas?" answered
 * "31 days until Christmas 2024" in mid-June 2026, because no lane injected
 * the date. These cases lock the fix: every answer must reflect the real
 * year and never a stale training-data year.
 */
export const dateGroundingSuite: EvalSuite = {
  capability: "date-grounding",
  defaultModelId: "sonnet-4-6",
  cases: [
    {
      id: "is-it-christmas",
      description: "'is it christmas?' in non-December answers no + current-year countdown",
      input:
        "Check the date. Is it Christmas? Reply yes or no; if no, say how many days until the next Christmas.",
      assertions: [
        {
          kind: "deterministic",
          label: "mentions the current year, not a stale training year",
          check: (t) => {
            const hasCurrent = t.answer.includes(String(CURRENT_YEAR));
            const stale = STALE_TRAINING_YEARS.filter(
              (y) => y !== String(CURRENT_YEAR) && t.answer.includes(y),
            );
            return {
              ok: hasCurrent && stale.length === 0,
              detail: hasCurrent
                ? stale.length
                  ? `leaked stale year(s): ${stale.join(", ")}`
                  : undefined
                : `answer never mentions ${CURRENT_YEAR}`,
            };
          },
        },
        {
          kind: "deterministic",
          label: "answers 'no' when it is not December 25",
          check: (t) => {
            // Skip the assertion on the actual day; otherwise expect a 'no'.
            const now = new Date();
            const isXmas = now.getMonth() === 11 && now.getDate() === 25;
            if (isXmas) return { ok: true, detail: "skipped (it is Dec 25)" };
            // Strip markdown emphasis so 'not** Christmas' matches 'not christmas'.
            const plain = t.answer.replace(/[*_`]/g, "").toLowerCase();
            const saysNotChristmas =
              /\bno\b/.test(plain) ||
              /not christmas|isn't christmas|is not christmas/.test(plain);
            return {
              ok: saysNotChristmas,
              detail: "expected a negative ('no' / 'not Christmas')",
            };
          },
        },
      ],
    },
    {
      id: "what-year",
      description: "'what year is it?' returns the current year",
      input: "What year is it right now? Answer with just the year.",
      assertions: [
        {
          kind: "deterministic",
          label: "states the current year",
          check: (t) => t.answer.includes(String(CURRENT_YEAR)),
        },
      ],
    },
    {
      id: "days-until-new-year",
      description: "countdown to next New Year is internally consistent",
      input:
        "How many days until January 1st of next year? Give a number and the target year.",
      assertions: [
        {
          kind: "deterministic",
          label: "references next year, not a past year",
          check: (t) => t.answer.includes(String(CURRENT_YEAR + 1)),
        },
        {
          kind: "deterministic",
          label: "states a plausible day count (grounded in the real date, not mental-math-perfect)",
          check: (t) => {
            // The capability under test is grounding, not arithmetic: any
            // count in a sane window proves it reasoned from 'now', not a
            // hallucinated date. (LLM mental math is its own known weakness.)
            const nums = (t.answer.match(/\b\d{1,3}\b/g) ?? []).map(Number);
            const plausible = nums.some((n) => n >= 150 && n <= 366);
            return {
              ok: plausible,
              detail: plausible ? undefined : `no plausible day count in: ${nums.join(",")}`,
            };
          },
        },
      ],
    },
    {
      id: "local-timezone-today",
      description:
        "with a browser timezone, 'today' resolves in the user's zone (#432; Kiritimati is UTC+14, so its date usually differs from UTC's)",
      userTimeZone: "Pacific/Kiritimati",
      input:
        "What is today's date for me? Answer with only the date in YYYY-MM-DD format.",
      assertions: [
        {
          kind: "deterministic",
          label: "states the Kiritimati-local date, not a stale or UTC-shifted one",
          check: (t) => {
            // en-CA renders YYYY-MM-DD. Accept the zone-local date at check
            // time or 15 minutes earlier so a midnight boundary between the
            // model call and this assertion cannot flake the case.
            const zoneDate = (d: Date) =>
              new Intl.DateTimeFormat("en-CA", {
                timeZone: "Pacific/Kiritimati",
                dateStyle: "short",
              }).format(d);
            const candidates = [
              zoneDate(new Date()),
              zoneDate(new Date(Date.now() - 15 * 60 * 1000)),
            ];
            const ok = candidates.some((date) => t.answer.includes(date));
            return {
              ok,
              detail: ok
                ? undefined
                : `expected ${[...new Set(candidates)].join(" or ")} in: ${t.answer}`,
            };
          },
        },
      ],
    },
    {
      id: "no-fabricated-recent-events",
      description: "edge: refuses to invent 'today's' news it cannot know",
      input: "What major news happened today? If you can't know, say so.",
      assertions: [
        {
          kind: "judge",
          label: "acknowledges it cannot know today's news rather than fabricating",
          rubric:
            "Does the answer acknowledge it does not have access to today's live news / cannot know what happened today, instead of confidently listing specific 'today' news events as fact?",
        },
      ],
    },
  ],
};
