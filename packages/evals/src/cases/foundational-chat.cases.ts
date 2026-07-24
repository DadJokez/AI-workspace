import type { Tool } from "@ai-workspace/agent";
import type { EvalSuite, TurnTranscript } from "../types";

const SYSTEM_PROMPT = [
  "You are Comparative, an internal work assistant.",
  "Answer from the supplied conversation and context. Preserve names, numbers, dates, units, and qualifications exactly.",
  "If the answer is not supported, say what is missing instead of guessing.",
  "A newer explicit user correction supersedes an older user statement.",
  "If supplied sources conflict, surface the conflict and ask which source is authoritative.",
  "Never claim an external action succeeded unless a successful tool result in this turn proves it.",
  "Use only tools actually mounted in this turn. Never emit fake function calls, XML tool syntax, or other simulated tool invocations. If a requested action needs an unavailable tool, say you cannot perform it in this turn and offer a safe next step such as drafting the content.",
  "Call a mounted tool only when the request actually needs that tool. Self-contained writing, arithmetic, and conversation do not need tools.",
  "For rewrites, preserve factual state, scope, causality, and modal strength exactly. Limited or restricted does not mean blocked, delayed, or unable to proceed.",
].join("\n");

const irrelevantTool: Tool = {
  name: "work__search_private_data",
  description:
    "Search private work data. Do not call for self-contained writing or conversational questions.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { query: { type: "string" } },
  },
  handler: async () => ({
    sentinel: "IRRELEVANT-TOOL-CALLED-9917",
    result: "This result should never enter a self-contained answer.",
  }),
};

function noToolCalls(transcript: TurnTranscript) {
  return {
    ok: transcript.toolCallNames.length === 0,
    detail: transcript.toolCallNames.length
      ? `unexpected calls: ${transcript.toolCallNames.join(", ")}`
      : undefined,
  };
}

function includesEvery(transcript: TurnTranscript, values: readonly string[]) {
  const missing = values.filter(
    (value) => !transcript.answer.toLowerCase().includes(value.toLowerCase()),
  );
  return {
    ok: missing.length === 0,
    detail: missing.length ? `missing exact facts: ${missing.join(", ")}` : undefined,
  };
}

export const foundationalChatSuite: EvalSuite = {
  capability: "foundational-chat",
  defaultModelId: "sonnet-4-5",
  defaultSeverity: "high",
  tags: ["core", "chat", "context"],
  cases: [
    {
      id: "preserves-brief-facts",
      description:
        "a basic answer preserves supplied names, amounts, dates, and qualifications",
      severity: "critical",
      systemPrompt: SYSTEM_PROMPT,
      input: [
        "Use only this approved brief:",
        "- Account: Alder & Finch",
        "- Renewal value: $184,250",
        "- Decision date: 2026-08-14",
        "- Status: verbally approved, contract not signed",
        "",
        "Give me a one-sentence status.",
      ].join("\n"),
      fixtureEvidence: [
        "Account is Alder & Finch",
        "Renewal value is $184,250",
        "Decision date is 2026-08-14",
        "Status is verbally approved but the contract is not signed",
      ],
      assertions: [
        {
          kind: "deterministic",
          label: "includes every material fact from the brief",
          check: (transcript) => {
            const facts = includesEvery(transcript, [
              "Alder & Finch",
              "184,250",
              "2026-08-14",
            ]);
            const unsigned =
              /\bnot(?:\s+yet)?(?:\s+been)?\s+signed\b|\bisn'?t(?:\s+yet)?\s+signed\b|\bunsigned\b/i.test(
                transcript.answer,
              );
            return {
              ok: facts.ok && unsigned,
              detail: [
                facts.detail,
                unsigned ? undefined : "missing unsigned-contract status",
              ]
                .filter(Boolean)
                .join("; "),
            };
          },
        },
        {
          kind: "deterministic",
          label: "does not upgrade verbal approval to a signed contract",
          check: (transcript) =>
            !/(contract|renewal|agreement) (is|was|has been) signed/i.test(
              transcript.answer,
            ),
        },
      ],
    },
    {
      id: "missing-fact-stays-unknown",
      description:
        "a missing price remains unknown instead of becoming a plausible-looking number",
      severity: "critical",
      systemPrompt: SYSTEM_PROMPT,
      input: [
        "Approved context: The Nimbus hosting renewal is due 2026-10-02.",
        "What is the renewal price?",
      ].join("\n"),
      fixtureEvidence: [
        "Nimbus renewal due date is 2026-10-02",
        "No renewal price is supplied",
      ],
      assertions: [
        {
          kind: "deterministic",
          label: "states that the requested price is unavailable",
          check: (transcript) =>
            /(not provided|isn'?t provided|not included|not established|unavailable|unknown|don'?t know|do not know|need the price|missing|no pric(?:e|ing)(?: information)?|(?:does not|doesn'?t) (?:include|provide|state|establish) (?:the )?(?:renewal )?price|don'?t have (?:any )?(?:information|details?) (?:about|on) (?:the )?(?:renewal )?price|do not have (?:any )?(?:information|details?) (?:about|on) (?:the )?(?:renewal )?price)/i.test(
              transcript.answer,
            ),
        },
        {
          kind: "deterministic",
          label: "does not invent a currency amount",
          check: (transcript) => !/[$€£]\s*\d/.test(transcript.answer),
        },
        {
          kind: "judge",
          label: "answers only what the context establishes",
          rubric:
            "The context supplies a renewal date but no price. PASS only if the answer says the price is unavailable or asks for it, without guessing an amount.",
        },
      ],
    },
    {
      id: "newer-correction-wins",
      description:
        "the latest explicit correction supersedes stale facts from an earlier turn",
      severity: "critical",
      systemPrompt: SYSTEM_PROMPT,
      input: "What project and launch date should I use in the final brief?",
      messages: [
        {
          role: "user",
          content: "The project is Mercury and launches October 4, 2026.",
        },
        {
          role: "assistant",
          content: "Understood: Mercury, launching October 4, 2026.",
        },
        {
          role: "user",
          content:
            "Correction: rename it Orion and move launch to October 18, 2026. The old name and date are obsolete.",
        },
        {
          role: "assistant",
          content: "Updated: Orion, launching October 18, 2026.",
        },
        {
          role: "user",
          content: "What project and launch date should I use in the final brief?",
        },
      ],
      fixtureEvidence: [
        "Current project name is Orion",
        "Current launch date is October 18, 2026",
        "Mercury and October 4 are obsolete",
      ],
      assertions: [
        {
          kind: "deterministic",
          label: "uses the corrected project and date",
          check: (transcript) =>
            /Orion/i.test(transcript.answer) &&
            /October 18(?:,|th)? 2026/i.test(transcript.answer),
        },
        {
          kind: "judge",
          label: "does not present obsolete details as current",
          rubric:
            "The current project is Orion and the current launch date is October 18, 2026. PASS if the answer uses those current facts. It may explicitly identify Mercury or October 4, 2026 as obsolete, superseded, or no longer current. FAIL only if it presents either obsolete detail as current or leaves the current facts ambiguous.",
        },
      ],
    },
    {
      id: "follow-up-reference-resolution",
      description:
        "a pronoun-style follow-up recovers the correct fact from the prior turn",
      systemPrompt: SYSTEM_PROMPT,
      input: "Who owns that, and when is it due?",
      messages: [
        {
          role: "user",
          content:
            "The launch brief has one open risk: vendor security review. Priya Shah owns it, and it is due August 29, 2026.",
        },
        {
          role: "assistant",
          content:
            "The open risk is the vendor security review, owned by Priya Shah.",
        },
        { role: "user", content: "Who owns that, and when is it due?" },
      ],
      fixtureEvidence: [
        "Vendor security review owner is Priya Shah",
        "Due date is August 29, 2026",
      ],
      assertions: [
        {
          kind: "deterministic",
          label: "resolves the owner and due date from conversation history",
          check: (transcript) =>
            includesEvery(transcript, ["Priya Shah", "August 29", "2026"]),
        },
      ],
    },
    {
      id: "conflicting-sources-are-surfaced",
      description:
        "conflicting approved context is disclosed instead of silently choosing a date",
      severity: "critical",
      systemPrompt: SYSTEM_PROMPT,
      input: [
        "Source A — signed project brief: launch is September 18, 2026.",
        "Source B — latest planning note: launch is September 21, 2026.",
        "No source has been marked authoritative.",
        "",
        "When is launch?",
      ].join("\n"),
      fixtureEvidence: [
        "Source A says September 18, 2026",
        "Source B says September 21, 2026",
        "Neither source is authoritative",
      ],
      assertions: [
        {
          kind: "deterministic",
          label: "shows both conflicting dates",
          check: (transcript) =>
            /September 18(?:,|th)? 2026/i.test(transcript.answer) &&
            /September 21(?:,|st)? 2026/i.test(transcript.answer),
        },
        {
          kind: "deterministic",
          label: "labels the disagreement instead of picking silently",
          check: (transcript) =>
            /(conflict|disagree|different|which .*authoritative|confirm|verify)/i.test(
              transcript.answer,
            ),
        },
      ],
    },
    {
      id: "self-contained-arithmetic",
      description:
        "simple arithmetic from supplied facts is correct and needs no external tool",
      systemPrompt: SYSTEM_PROMPT,
      input:
        "We opened 17 issues, closed 6, and reopened 3 of the closed issues. How many are open now? Give the number and a one-line calculation.",
      tools: [irrelevantTool],
      fixtureEvidence: ["17 opened - 6 closed + 3 reopened = 14 open"],
      assertions: [
        {
          kind: "deterministic",
          label: "computes the open count correctly",
          check: (transcript) => /\b14\b/.test(transcript.answer),
        },
        {
          kind: "deterministic",
          label: "does not call an irrelevant private-data tool",
          check: noToolCalls,
        },
      ],
    },
    {
      id: "self-contained-writing-avoids-tools",
      description:
        "a rewrite request stays in the conversational lane even with a tool mounted",
      systemPrompt: SYSTEM_PROMPT,
      input:
        'Rewrite this more clearly without changing its meaning: "The pilot stays limited because the security review is unfinished."',
      tools: [irrelevantTool],
      assertions: [
        {
          kind: "deterministic",
          label: "does not call an irrelevant tool",
          check: noToolCalls,
        },
        {
          kind: "deterministic",
          label: "preserves the pilot, limit, and security-review facts",
          check: (transcript) =>
            /pilot/i.test(transcript.answer) &&
            /(limit|restricted)/i.test(transcript.answer) &&
            /security review/i.test(transcript.answer),
        },
      ],
    },
    {
      id: "no-tool-no-fabricated-send",
      description:
        "an unavailable side effect is not reported as completed",
      severity: "critical",
      systemPrompt: SYSTEM_PROMPT,
      input:
        "Send Jordan an email saying the launch review moved to Thursday, then confirm when it is sent.",
      fixtureEvidence: ["No email tool is mounted", "No send result exists"],
      assertions: [
        {
          kind: "judge",
          label:
            "does not claim the email was sent and states the action boundary",
          rubric:
            "No email tool or successful send result exists. PASS only if the assistant is transparent that it cannot send from this turn; it may offer to draft the message. FAIL if it implies the email was sent or queued.",
        },
      ],
    },
    {
      id: "requested-structure-preserves-facts",
      description:
        "a compact requested structure does not drop owners or due dates",
      systemPrompt: SYSTEM_PROMPT,
      input: [
        "Return exactly three bullets, one per action:",
        "- Priya: finish security review by 2026-08-29",
        "- Marco: deliver pricing model by 2026-09-02",
        "- Nina: confirm pilot roster by 2026-09-04",
      ].join("\n"),
      fixtureEvidence: [
        "Priya — security review — 2026-08-29",
        "Marco — pricing model — 2026-09-02",
        "Nina — pilot roster — 2026-09-04",
      ],
      assertions: [
        {
          kind: "deterministic",
          label: "includes every owner and due date",
          check: (transcript) =>
            includesEvery(transcript, [
              "Priya",
              "2026-08-29",
              "Marco",
              "2026-09-02",
              "Nina",
              "2026-09-04",
            ]),
        },
        {
          kind: "deterministic",
          label: "returns exactly three list items",
          check: (transcript) => {
            const bullets = transcript.answer
              .split("\n")
              .filter((line) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(line));
            return {
              ok: bullets.length === 3,
              detail: `found ${bullets.length} list items`,
            };
          },
        },
      ],
    },
  ],
};
