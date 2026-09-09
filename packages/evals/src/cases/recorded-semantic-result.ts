import { readFileSync } from "node:fs";
import type { EvalCase } from "../types";
import { REPLAY_JUDGES, rubricKey } from "../judge-replay";
import {
  JUDGE_RUBRIC_CONTROLS,
  RECORDED_CONTROLS_PATH,
  type RecordedControls,
} from "./judge-rubric-controls";

/** Test-only lookup of real judge verdicts, never the control's expected verdict. */
export function recordedSemanticResult(testCase: EvalCase, label: string, answer: string): boolean {
  const assertion = testCase.assertions.find((item) => item.label === label);
  const control = JUDGE_RUBRIC_CONTROLS.find((item) =>
    item.caseId === testCase.id && item.label === label && item.answer === answer,
  );
  if (assertion?.kind !== "judge" || !control) {
    throw new Error(`Missing semantic control: ${testCase.id}/${label}/${answer}`);
  }
  const recorded = JSON.parse(readFileSync(RECORDED_CONTROLS_PATH, "utf8")) as RecordedControls;
  const key = rubricKey(control.capability, control.caseId, label);
  if (recorded.rubrics[key] !== assertion.rubric) {
    throw new Error(`Re-record changed rubric with judge-replay --controls --record: ${key}`);
  }
  const verdicts = REPLAY_JUDGES.map((judge) => {
    const verdict = recorded.verdicts.find((item) => item.id === control.id && item.judge === judge);
    if (!verdict) throw new Error(`Missing recorded verdict: ${control.id}/${judge}`);
    return verdict.pass;
  });
  if (new Set(verdicts).size !== 1) throw new Error(`Judges disagree: ${control.id}`);
  return verdicts[0]!;
}
