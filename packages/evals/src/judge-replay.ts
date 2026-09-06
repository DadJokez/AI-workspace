import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MODELS,
  type BedrockClient,
  type ConverseStreamParams,
  type ModelId,
  getBedrockClient,
} from "@ai-workspace/agent";
import { estimateUsageCostUsd } from "./benchmarks/model-routing";
import {
  JUDGE_RUBRIC_CONTROLS,
  RECORDED_CONTROLS_PATH,
  type JudgeRubricControl,
  type RecordedControls,
} from "./cases/judge-rubric-controls";
import { judgeSeesToolReceipts } from "./harness";
import { JUDGE_MODEL_ID, type ToolReceipt, runJudge } from "./judge";
import { SUITES } from "./run";
import type { CapabilityResult, CaseResult } from "./types";

/**
 * Same-answer judge replay: re-grade the answers a stored eval report
 * already holds, without re-running the candidate, so a rubric or judge
 * change is measured on identical inputs (docs/REGRESSION_GAUNTLET.md,
 * "Changing a judge rubric").
 *
 *   tsx src/judge-replay.ts --report eval-reports/<stamp>.json [--report …]
 *       [--case <capability>/<caseId> …]      default: every case with a judge assertion
 *       [--judge haiku-4-5 --judge sonnet-4-5] default: both
 *       [--rubrics <overrides.json>]           {"<capability>/<caseId>/<label>": "<rubric>"}
 *       [--receipts auto|off]                  auto = the harness rule; off = pre-receipt prompt
 *       [--out <verdicts.json>]
 *
 *   tsx src/judge-replay.ts --controls [--judge …] [--record]
 *       grades src/cases/judge-rubric-controls.ts; --record rewrites the
 *       recorded verdicts the unit test pins.
 *
 * Needs AWS_REGION and BEDROCK_CLIENT=real like `pnpm eval`. The stored
 * report keeps tool names and result previews but not call arguments, so a
 * replayed receipt line carries no argument JSON (`input` undefined).
 */

export const REPLAY_JUDGES: readonly ModelId[] = ["haiku-4-5", "sonnet-4-5"];

/** A client that sends the judge prompt to `modelId` instead of the pin. */
export function judgeClientFor(
  modelId: ModelId,
  base: BedrockClient,
): BedrockClient {
  if (modelId === JUDGE_MODEL_ID) return base;
  const model = MODELS[modelId];
  return {
    converseStream: (params: ConverseStreamParams) =>
      base.converseStream({
        ...params,
        bedrockModelId: model.bedrockModelId,
        supportsPromptCaching: model.supportsPromptCaching,
      }),
  };
}

export function rubricKey(
  capability: string,
  caseId: string,
  label: string,
): string {
  return `${capability}/${caseId}/${label}`;
}

/** The judge assertions a case defines, from the checked-in suites. */
export function findJudgeAssertions(
  capability: string,
  caseId: string,
): Array<{ label: string; rubric: string; referenceEvidence: string[] }> {
  const suite = SUITES.find((s) => s.capability === capability);
  const testCase = suite?.cases.find((c) => c.id === caseId);
  if (!testCase) {
    throw new Error(`no such case: ${capability}/${caseId}`);
  }
  return testCase.assertions.flatMap((assertion) =>
    assertion.kind === "judge"
      ? [
          {
            label: assertion.label,
            rubric: assertion.rubric,
            referenceEvidence: [...(assertion.referenceEvidence ?? [])],
          },
        ]
      : [],
  );
}

/** Receipts from a stored case result: names and previews, no arguments. */
export function receiptsFromReport(
  result: Pick<CaseResult, "toolCalls" | "toolResults">,
): ToolReceipt[] {
  return result.toolCalls.map((tool, index) => {
    const stored = result.toolResults[index];
    return {
      tool,
      output: stored?.outputPreview ?? "(no result recorded)",
      ...(stored?.isError ? { isError: true } : {}),
    };
  });
}

export interface ReplayVerdict {
  source: string;
  capability: string;
  caseId: string;
  label: string;
  judge: ModelId;
  pass: boolean;
  reason: string;
  costUsd: number;
}

interface ReplayArgs {
  reports: string[];
  cases: string[];
  judges: ModelId[];
  rubricOverrides: Record<string, string>;
  receipts: "auto" | "off";
  out?: string;
  controls: boolean;
  record: boolean;
}

function parseArgs(argv: readonly string[]): ReplayArgs {
  const args: ReplayArgs = {
    reports: [],
    cases: [],
    judges: [],
    rubricOverrides: {},
    receipts: "auto",
    controls: false,
    record: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = () => {
      const next = argv[++i];
      if (!next || next.startsWith("--")) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === "--report") args.reports.push(value());
    else if (flag === "--case") args.cases.push(value());
    else if (flag === "--judge") {
      const id = value();
      if (!(id in MODELS)) throw new Error(`unknown judge ${id}`);
      args.judges.push(id as ModelId);
    } else if (flag === "--rubrics") {
      args.rubricOverrides = JSON.parse(readFileSync(value(), "utf8"));
    } else if (flag === "--receipts") {
      const mode = value();
      if (mode !== "auto" && mode !== "off") {
        throw new Error("--receipts must be auto or off");
      }
      args.receipts = mode;
    } else if (flag === "--out") args.out = value();
    else if (flag === "--controls") args.controls = true;
    else if (flag === "--record") args.record = true;
    else throw new Error(`unknown argument ${flag}`);
  }
  if (args.judges.length === 0) args.judges = [...REPLAY_JUDGES];
  return args;
}

function requireRealBedrock(): BedrockClient {
  if (!process.env.AWS_REGION) {
    throw new Error("judge replay needs AWS_REGION; refusing to run blind.");
  }
  if ((process.env.BEDROCK_CLIENT ?? "fake").toLowerCase() !== "real") {
    throw new Error("judge replay needs BEDROCK_CLIENT=real.");
  }
  return getBedrockClient();
}

async function judgeWith(
  base: BedrockClient,
  judges: readonly ModelId[],
  input: Parameters<typeof runJudge>[1],
  meta: Omit<ReplayVerdict, "judge" | "pass" | "reason" | "costUsd">,
): Promise<ReplayVerdict[]> {
  return Promise.all(
    judges.map(async (judge) => {
      const verdict = await runJudge(judgeClientFor(judge, base), input);
      return {
        ...meta,
        judge,
        pass: verdict.pass,
        reason: verdict.reason,
        costUsd: estimateUsageCostUsd(judge, verdict),
      };
    }),
  );
}

async function replayReports(
  base: BedrockClient,
  args: ReplayArgs,
): Promise<ReplayVerdict[]> {
  const verdicts: ReplayVerdict[] = [];
  for (const reportPath of args.reports) {
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      results: CapabilityResult[];
    };
    for (const capability of report.results) {
      for (const result of capability.results) {
        const key = `${capability.capability}/${result.caseId}`;
        if (args.cases.length > 0 && !args.cases.includes(key)) continue;
        const assertions = findJudgeAssertions(
          capability.capability,
          result.caseId,
        );
        if (assertions.length === 0) continue;
        const withReceipts =
          args.receipts === "auto" && judgeSeesToolReceipts(result.tags);
        for (const assertion of assertions) {
          const overrideKey = rubricKey(
            capability.capability,
            result.caseId,
            assertion.label,
          );
          const rubric = args.rubricOverrides[overrideKey] ?? assertion.rubric;
          verdicts.push(
            ...(await judgeWith(
              base,
              args.judges,
              {
                rubric,
                answer: result.answer,
                referenceEvidence: [
                  ...result.fixtureEvidence,
                  ...assertion.referenceEvidence,
                ],
                ...(withReceipts
                  ? { toolReceipts: receiptsFromReport(result) }
                  : {}),
              },
              {
                source: reportPath,
                capability: capability.capability,
                caseId: result.caseId,
                label: assertion.label,
              },
            )),
          );
          process.stderr.write(".");
        }
      }
    }
  }
  process.stderr.write("\n");
  return verdicts;
}

export function controlRubric(control: JudgeRubricControl): string {
  const assertion = findJudgeAssertions(control.capability, control.caseId).find(
    (a) => a.label === control.label,
  );
  if (!assertion) {
    throw new Error(
      `control ${control.id}: no judge assertion ${rubricKey(control.capability, control.caseId, control.label)}`,
    );
  }
  return assertion.rubric;
}

async function replayControls(
  base: BedrockClient,
  args: ReplayArgs,
): Promise<ReplayVerdict[]> {
  const verdicts: ReplayVerdict[] = [];
  for (const control of JUDGE_RUBRIC_CONTROLS) {
    verdicts.push(
      ...(await judgeWith(
        base,
        args.judges,
        {
          rubric: controlRubric(control),
          answer: control.answer,
          toolReceipts: control.toolReceipts,
        },
        {
          source: control.id,
          capability: control.capability,
          caseId: control.caseId,
          label: control.label,
        },
      )),
    );
    process.stderr.write(".");
  }
  process.stderr.write("\n");
  return verdicts;
}

function renderTable(verdicts: readonly ReplayVerdict[]): string {
  const rows = verdicts.map(
    (v) =>
      `| ${v.source} | ${v.capability}/${v.caseId} | ${v.label} | ${v.judge} | ${v.pass ? "PASS" : "FAIL"} | ${v.reason.replace(/\|/g, "\\|").slice(0, 160)} |`,
  );
  const cost = verdicts.reduce((sum, v) => sum + v.costUsd, 0);
  return [
    "| source | case | assertion | judge | verdict | reason |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    `${verdicts.length} verdicts · ~$${cost.toFixed(4)}`,
  ].join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const base = requireRealBedrock();
  const verdicts = args.controls
    ? await replayControls(base, args)
    : await replayReports(base, args);
  console.log(renderTable(verdicts));
  if (args.out) {
    writeFileSync(args.out, JSON.stringify(verdicts, null, 2));
  }
  if (args.controls && args.record) {
    const recorded: RecordedControls = {
      recordedAt: new Date().toISOString(),
      rubrics: Object.fromEntries(
        JUDGE_RUBRIC_CONTROLS.map((control) => [
          rubricKey(control.capability, control.caseId, control.label),
          controlRubric(control),
        ]),
      ),
      verdicts: verdicts.map((v) => ({
        id: v.source,
        judge: v.judge,
        pass: v.pass,
        reason: v.reason,
      })),
    };
    writeFileSync(
      RECORDED_CONTROLS_PATH,
      `${JSON.stringify(recorded, null, 2)}\n`,
    );
    console.log(`recorded → ${RECORDED_CONTROLS_PATH}`);
  }
  const unexpected = args.controls
    ? verdicts.filter((v) => {
        const control = JUDGE_RUBRIC_CONTROLS.find((c) => c.id === v.source)!;
        return v.pass !== (control.expect === "PASS");
      })
    : [];
  if (unexpected.length > 0) {
    console.error(
      `\n${unexpected.length} control(s) did not get their expected verdict.`,
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
