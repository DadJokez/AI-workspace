import { DEFAULT_MODEL_ID } from "@ai-workspace/agent";
import type { Assertion, EvalSuite, TurnTranscript } from "../types";

export function visibleProviderAnswer(transcript: TurnTranscript) {
  return {
    ok:
      transcript.answer.trim().length > 0 &&
      !/^\s/.test(transcript.answer) &&
      !/<\/?(?:reasoning|thinking|think|\uff5cDSML\uff5c)/i.test(transcript.answer) &&
      !transcript.events.some((event) => event.type === "error"),
    detail: "answer must be nonempty, start without whitespace, and contain no provider protocol or runtime error",
  };
}

const visible: Assertion = {
  kind: "deterministic",
  label: "visible answer contains no provider markup, leading whitespace, or runtime errors",
  check: visibleProviderAnswer,
};

export const providerCompatibilitySuite: EvalSuite = {
  capability: "provider-compatibility",
  defaultModelId: DEFAULT_MODEL_ID,
  defaultSeverity: "high",
  tags: ["core", "provider-compatibility"],
  cases: [
    {
      id: "plain-answer-boundary",
      description: "a simple answer has no provider-added leading space",
      input: "Reply with exactly Ready. and nothing else.",
      assertions: [visible, {
        kind: "deterministic",
        label: "exact output is preserved after provider normalization",
        check: (transcript) => transcript.answer === "Ready.",
      }],
    },
    {
      id: "reasoning-stays-out-of-answer",
      description: "a calculation returns its result without provider reasoning wrappers",
      input: "What is 6 times 7? Reply with only the number, no explanation.",
      assertions: [visible, {
        kind: "deterministic",
        label: "the result is exactly 42, not an empty sanitized answer",
        check: (transcript) => transcript.answer === "42",
      }],
    },
    {
      id: "tool-history-with-no-mounted-tools",
      description: "a follow-up uses historical tool evidence with valid Converse schemas and no new execution",
      input: "What was the project name in that result? Reply with only the name. Do not run a tool.",
      messages: [
        { role: "user", content: "Look up the project name." },
        { role: "assistant", content: "", toolCalls: [{ id: "prior", name: "project_lookup", input: {} }] },
        { role: "tool", content: "", toolResults: [{ toolCallId: "prior", output: { project: "Orion" } }] },
        { role: "assistant", content: "The project is Orion." },
        { role: "user", content: "What was the project name in that result? Reply with only the name. Do not run a tool." },
      ],
      tools: [],
      assertions: [visible, {
        kind: "deterministic",
        label: "the historical result is answered without new tool calls",
        check: (transcript) => transcript.answer === "Orion" && transcript.toolCallNames.length === 0,
      }, {
        kind: "deterministic",
        label: "the actual request retains the historical tool schema",
        check: (transcript) => transcript.events.some((event) =>
          event.type === "provider-request" && event.request.tools.some((tool) => tool.name === "project_lookup")),
      }],
    },
  ],
};
