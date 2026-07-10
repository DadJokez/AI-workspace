import {
  type BedrockClient,
  ToolRegistry,
  runAgentLoop,
} from "@ai-workspace/agent";

/**
 * LLM judge for qualitative assertions (FR-002). Haiku-only, capped, and
 * forced to a strict PASS/FAIL + one-line reason so the verdict is parseable
 * and cheap. Deterministic assertions are always preferred; the judge is for
 * "is this a faithful summary?"-style calls that code can't check.
 */
const JUDGE_SYSTEM = [
  "You are a strict evaluation judge. You are given a rubric question and an AI assistant's answer.",
  "Decide whether the answer satisfies the rubric.",
  "Respond on the FIRST line with exactly PASS or FAIL, then a second line with a brief reason.",
  "Be literal and strict: if the rubric is not clearly satisfied, FAIL. Do not be charitable.",
].join("\n");

export interface JudgeVerdict {
  pass: boolean;
  reason: string;
}

export async function runJudge(
  client: BedrockClient,
  input: { rubric: string; answer: string },
): Promise<JudgeVerdict> {
  const prompt = [
    `RUBRIC: ${input.rubric}`,
    "",
    "ANSWER:",
    input.answer || "(empty answer)",
  ].join("\n");

  let text = "";
  try {
    for await (const ev of runAgentLoop({
      modelId: "haiku-4-5",
      systemPrompt: JUDGE_SYSTEM,
      messages: [{ role: "user", content: prompt }],
      registry: new ToolRegistry(),
      context: { userId: "eval-judge" },
      maxTokens: 200,
      temperature: 0,
      client,
    })) {
      if (ev.type === "text-delta") text += ev.delta;
    }
  } catch (err) {
    return {
      pass: false,
      reason: `judge error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const firstLine = text.trim().split("\n")[0]?.trim().toUpperCase() ?? "";
  const pass = firstLine.startsWith("PASS");
  const reason = text.trim().split("\n").slice(1).join(" ").trim() || text.trim();
  return { pass, reason: reason.slice(0, 200) };
}
