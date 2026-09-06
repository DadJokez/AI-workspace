import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JUDGE_MODEL_ID } from "../judge";
import { REPLAY_JUDGES, controlRubric, rubricKey } from "../judge-replay";
import {
  JUDGE_RUBRIC_CONTROLS,
  RECORDED_CONTROLS_PATH,
  type RecordedControls,
} from "./judge-rubric-controls";

/**
 * Pins the calibration of the two reworded calendar rubrics (#907
 * follow-up). The verdicts come from real Bedrock, recorded by
 * `judge-replay.ts --controls --record`; this test checks that recording is
 * (a) complete for both judges, (b) what each control demands, and (c) made
 * against the rubric text as it stands — so editing a rubric fails here
 * until the controls are re-run and re-recorded. No model runs in CI.
 */
describe("judge rubric controls", () => {
  const recorded = JSON.parse(
    readFileSync(RECORDED_CONTROLS_PATH, "utf8"),
  ) as RecordedControls;
  const rerun =
    "re-run `AWS_REGION=us-east-1 BEDROCK_CLIENT=real pnpm --filter @ai-workspace/evals exec tsx src/judge-replay.ts --controls --record` and paste the table in the PR";

  it("covers both calendar rubrics with PASS and FAIL controls", () => {
    for (const key of [
      "gmail-calendar-faithfulness/calendar-confirmed-write",
      "model-routing/disconnected-calendar-stays-honest",
    ]) {
      const controls = JUDGE_RUBRIC_CONTROLS.filter(
        (c) => `${c.capability}/${c.caseId}` === key,
      );
      expect(controls.filter((c) => c.expect === "PASS").length, key).toBeGreaterThanOrEqual(2);
      expect(controls.filter((c) => c.expect === "FAIL").length, key).toBeGreaterThanOrEqual(2);
    }
    expect(new Set(JUDGE_RUBRIC_CONTROLS.map((c) => c.id)).size).toBe(
      JUDGE_RUBRIC_CONTROLS.length,
    );
  });

  it("the rubrics name their FAIL conditions; the write rubric names the receipt as authoritative", () => {
    for (const control of JUDGE_RUBRIC_CONTROLS) {
      expect(controlRubric(control)).toContain("FAIL if any one of these is true");
    }
    const write = controlRubric(
      JUDGE_RUBRIC_CONTROLS.find((c) => c.caseId === "calendar-confirmed-write")!,
    );
    expect(write).toContain("The TOOL RECEIPTS are the authoritative record");
    expect(write).toContain("no google__create_event call or an error result");
    expect(write).toContain("another confirmation or approval is still needed");
    const disconnected = controlRubric(
      JUDGE_RUBRIC_CONTROLS.find(
        (c) => c.caseId === "disconnected-calendar-stays-honest",
      )!,
    );
    expect(disconnected).toContain("naming Comparative");
    expect(disconnected).toContain("says a calendar tool or Google was called");
  });

  it("was recorded against the rubrics as they stand now", () => {
    for (const control of JUDGE_RUBRIC_CONTROLS) {
      const key = rubricKey(control.capability, control.caseId, control.label);
      expect(recorded.rubrics[key], `${key} changed: ${rerun}`).toBe(
        controlRubric(control),
      );
    }
  });

  it("both judges give every control its expected verdict", () => {
    expect(REPLAY_JUDGES).toContain(JUDGE_MODEL_ID);
    for (const control of JUDGE_RUBRIC_CONTROLS) {
      for (const judge of REPLAY_JUDGES) {
        const verdict = recorded.verdicts.find(
          (v) => v.id === control.id && v.judge === judge,
        );
        expect(verdict, `${control.id} × ${judge} not recorded: ${rerun}`).toBeDefined();
        expect(
          verdict!.pass,
          `${control.id} × ${judge} (${control.why}): ${verdict!.reason}`,
        ).toBe(control.expect === "PASS");
      }
    }
  });
});
