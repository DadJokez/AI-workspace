import { DEFAULT_MODEL_ID, EXACT_OUTPUT_CONTRACT } from "@ai-workspace/agent";
import type {
  Assertion,
  EvalCase,
  EvalSuite,
} from "../types";

const BASE_SYSTEM_PROMPT = [
  "You are Comparative, an internal work assistant.",
  "Preserve user-supplied facts and formatting constraints.",
  EXACT_OUTPUT_CONTRACT,
].join("\n");

const APPROVED_MEMORY_SYSTEM_PROMPT = [
  BASE_SYSTEM_PROMPT,
  "",
  "Personal context approved by the user:",
  "# Personal Context",
  "## Current Priorities",
  "- API status is Ready.",
  "- Mobile QA status is Blocked.",
  "- The pilot is ready, but Mobile QA is blocked.",
  "- Project Orion is owned by Priya.",
  "- Launch date is 31/07/2026.",
  "- Target temperature is 21 °C.",
].join("\n");

function normalizedTransport(answer: string): string {
  return answer.replace(/\r\n/g, "\n").trimEnd();
}

function exactTransport(expected: string): Assertion {
  return {
    kind: "deterministic",
    label: "matches the exact requested transport",
    check: (transcript) => {
      const actual = normalizedTransport(transcript.answer);
      return {
        ok: actual === expected,
        detail:
          actual === expected
            ? undefined
            : `expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
      };
    },
  };
}

function markdownList(itemCount: number): Assertion {
  return {
    kind: "deterministic",
    label: `renders exactly ${itemCount} real Markdown list items`,
    check: (transcript) => {
      const lines = normalizedTransport(transcript.answer).split("\n");
      const markdownItems = lines.filter((line) => /^- \S/.test(line));
      const decorativeGlyphs = lines.some((line) => /(?:^|\s)•\s/.test(line));
      return {
        ok:
          lines.length === itemCount &&
          markdownItems.length === itemCount &&
          !decorativeGlyphs,
        detail: `${lines.length} line(s), ${markdownItems.length} Markdown item(s), decorative glyphs=${decorativeGlyphs}`,
      };
    },
  };
}

function exactJsonKeys(keys: readonly string[]): Assertion {
  return {
    kind: "deterministic",
    label: `returns valid JSON with only ${keys.join(", ")}`,
    check: (transcript) => {
      try {
        const value = JSON.parse(normalizedTransport(transcript.answer)) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return { ok: false, detail: "response was not a JSON object" };
        }
        const actualKeys = Object.keys(value as Record<string, unknown>).sort();
        const expectedKeys = [...keys].sort();
        return {
          ok: JSON.stringify(actualKeys) === JSON.stringify(expectedKeys),
          detail: `received keys: ${actualKeys.join(", ")}`,
        };
      } catch (error) {
        return {
          ok: false,
          detail: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}

function exactCase({
  id,
  description,
  input,
  expected,
  systemPrompt = BASE_SYSTEM_PROMPT,
  assertions = [],
  repeat,
  passPolicy,
}: {
  id: string;
  description: string;
  input: string;
  expected: string;
  systemPrompt?: string;
  assertions?: Assertion[];
  repeat?: number;
  passPolicy?: "all" | "majority";
}): EvalCase {
  return {
    id,
    description,
    severity: "high",
    tags: ["core", "exact-output"],
    systemPrompt,
    input,
    fixtureEvidence: [expected],
    assertions: [exactTransport(expected), ...assertions],
    ...(repeat ? { repeat } : {}),
    ...(passPolicy ? { passPolicy } : {}),
  };
}

const directCases: EvalCase[] = [
  exactCase({
    id: "exact-markdown-list",
    description:
      "an exact two-item Markdown request stays a real list rather than a decorative paragraph",
    input: [
      "Return exactly these two Markdown bullets and nothing else:",
      "- API — Ready.",
      "- Mobile QA — Blocked.",
    ].join("\n"),
    expected: "- API — Ready.\n- Mobile QA — Blocked.",
    assertions: [markdownList(2)],
  }),
  exactCase({
    id: "exact-prose-no-preamble",
    description:
      "supplied prose is returned without an introduction, closing, or styling",
    input:
      "Reply with exactly these two sentences and nothing else: The pilot is ready. Mobile QA is blocked.",
    expected: "The pilot is ready. Mobile QA is blocked.",
  }),
  exactCase({
    id: "exact-json-key-set",
    description:
      "an exact JSON object remains parseable and gains no unrequested key",
    input:
      'Return only this exact inline JSON object with exactly these three keys: {"project":"Orion","status":"ready","owner":"Priya"}',
    expected: '{"project":"Orion","status":"ready","owner":"Priya"}',
    assertions: [exactJsonKeys(["project", "status", "owner"])],
  }),
  exactCase({
    id: "exact-punctuation-and-unicode-spacing",
    description:
      "terminal punctuation and the Unicode space before a temperature unit survive",
    input:
      "Reply exactly with this sentence, preserving every character: Target temperature: 21 °C.",
    expected: "Target temperature: 21 °C.",
  }),
  exactCase({
    id: "exact-code-block-only",
    description:
      "a code-block-only request emits one fence with no surrounding prose",
    input: "Return exactly this code block and nothing else:\n```text\nREADY\n```",
    expected: "```text\nREADY\n```",
  }),
  // #644: a direct user message demanding an opaque-token echo is benign —
  // injection hardening must not refuse it. Repeated because the failure was
  // an intermittent refusal, not a formatting slip.
  exactCase({
    id: "benign-exact-token-echo",
    description:
      "a benign direct request to echo an opaque token is echoed exactly, not refused as injection",
    input: 'Reply exactly with "CBX-7745-TANGO"',
    expected: "CBX-7745-TANGO",
    repeat: 3,
    passPolicy: "majority",
  }),
];

const approvedMemoryCases: EvalCase[] = [
  exactCase({
    id: "approved-memory-exact-markdown-list",
    description:
      "approved memory supplies list values without changing the requested Markdown shape",
    systemPrompt: APPROVED_MEMORY_SYSTEM_PROMPT,
    input:
      "Using approved memory, return exactly two Markdown bullets and nothing else: API, then Mobile QA, in the form `- Name — Status.`",
    expected: "- API — Ready.\n- Mobile QA — Blocked.",
    assertions: [markdownList(2)],
  }),
  exactCase({
    id: "approved-memory-exact-prose",
    description:
      "approved memory supplies exact prose without a preamble or closing",
    systemPrompt: APPROVED_MEMORY_SYSTEM_PROMPT,
    input:
      "Using approved memory, reply with exactly two sentences and nothing else: the pilot sentence followed by the Mobile QA sentence.",
    expected: "The pilot is ready. Mobile QA is blocked.",
  }),
  exactCase({
    id: "approved-memory-exact-json",
    description:
      "approved memory fills an exact JSON schema without adding fields",
    systemPrompt: APPROVED_MEMORY_SYSTEM_PROMPT,
    input:
      'Using approved memory, return only inline JSON with exactly these keys in this order: {"project":"<project>","status":"ready","owner":"<owner>"}',
    expected: '{"project":"Orion","status":"ready","owner":"Priya"}',
    assertions: [exactJsonKeys(["project", "status", "owner"])],
  }),
  exactCase({
    id: "approved-memory-exact-punctuation",
    description:
      "an approved date retains its exact punctuation and final period",
    systemPrompt: APPROVED_MEMORY_SYSTEM_PROMPT,
    input:
      "Using approved memory, reply exactly in this form and preserve the final period: Launch date: <date>.",
    expected: "Launch date: 31/07/2026.",
  }),
  exactCase({
    id: "approved-memory-exact-code-block",
    description:
      "an approved memory value can be returned in one exact code block",
    systemPrompt: APPROVED_MEMORY_SYSTEM_PROMPT,
    input:
      "Using approved memory, return the launch date in exactly one code block and nothing else. The opening fence must be exactly ```text and the closing fence must be exactly ```.",
    expected: "```text\n31/07/2026\n```",
  }),
];

export const exactOutputSuite: EvalSuite = {
  capability: "exact-output",
  defaultModelId: DEFAULT_MODEL_ID,
  defaultSeverity: "high",
  tags: ["core", "chat", "formatting"],
  cases: [...directCases, ...approvedMemoryCases],
};
