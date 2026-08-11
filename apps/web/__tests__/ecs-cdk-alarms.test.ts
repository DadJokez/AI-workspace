import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * #509 class + #568: every alarm this stack owns must reach a human. An alarm
 * with no AlarmActions is an alarm nobody receives, and a liveness alarm that
 * treats missing data as OK passes hardest exactly when the service is gone.
 */
describe("AiWorkspaceEcsStack alarms", () => {
  let alarms: CloudFormationResource[];

  beforeAll(() => {
    alarms = synthAlarms();
  }, 300_000);

  function alarm(name: string) {
    const found = alarms.find(
      (resource) => resource.Properties?.AlarmName === name,
    );
    expect(found, `alarm ${name} is missing`).toBeDefined();
    return found!.Properties!;
  }

  const opsTopicArn = {
    "Fn::Join": [
      "",
      [
        "arn:",
        { Ref: "AWS::Partition" },
        ":sns:us-east-1:351478076796:ai-workspace-ops-alerts",
      ],
    ],
  };

  it("routes every stack-owned alarm to the ops SNS topic", () => {
    const names = alarms.map((resource) => resource.Properties?.AlarmName);
    expect(names).toEqual(
      expect.arrayContaining([
        "ai-workspace-memory-capture-failures",
        "ai-workspace-bedrock-sonnet-4-5-token-headroom",
        "ai-workspace-web-unhealthy-hosts",
        "ai-workspace-web-below-task-floor",
      ]),
    );
    for (const resource of alarms) {
      expect(
        resource.Properties?.AlarmActions,
        `alarm ${String(resource.Properties?.AlarmName)} has no action`,
      ).toEqual([opsTopicArn]);
    }
  });

  it("wires the memory-capture failure alarm that previously had no action", () => {
    expect(alarm("ai-workspace-memory-capture-failures")).toMatchObject({
      AlarmActions: [opsTopicArn],
      Namespace: "Comparative/Workers",
      MetricName: "MemoryCaptureFailures",
      Statistic: "Sum",
      Threshold: 1,
      TreatMissingData: "notBreaching",
    });
  });

  it("warns before shared Sonnet 4.5 quota exhaustion (#706)", () => {
    const properties = alarm(
      "ai-workspace-bedrock-sonnet-4-5-token-headroom",
    );

    expect(properties).toMatchObject({
      AlarmActions: [opsTopicArn],
      OKActions: [opsTopicArn],
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      EvaluationPeriods: 1,
      Threshold: 4_320_000,
      TreatMissingData: "notBreaching",
    });
    expect(properties.AlarmDescription).toContain("rolling 24-hour");
    expect(properties.Metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Expression:
            "FILL(inputTokens, 0) + MAX([FILL(cacheWriteTokens, 0), FILL(cacheWriteTokenCount, 0)]) + (FILL(outputTokens, 0) * 5)",
          ReturnData: true,
        }),
        metricQuery("inputTokens", "InputTokenCount"),
        metricQuery("outputTokens", "OutputTokenCount"),
        metricQuery("cacheWriteTokens", "CacheWriteInputTokens"),
        metricQuery("cacheWriteTokenCount", "CacheWriteInputTokenCount"),
      ]),
    );
  });

  it("alarms below the two-task web availability floor with missing data breaching (#568)", () => {
    expect(alarm("ai-workspace-web-below-task-floor")).toMatchObject({
      AlarmActions: [opsTopicArn],
      OKActions: [opsTopicArn],
      // RunningTaskCount is Container Insights-only; this cluster disables it.
      Namespace: "AWS/ECS",
      MetricName: "LiveTaskCount",
      Statistic: "Minimum",
      Period: 60,
      EvaluationPeriods: 3,
      DatapointsToAlarm: 3,
      ComparisonOperator: "LessThanThreshold",
      TreatMissingData: "breaching",
    });
    const properties = alarm("ai-workspace-web-below-task-floor");
    expect(properties.Dimensions).toEqual([
      { Name: "ClusterName", Value: "ai-workspace-prod" },
      { Name: "ServiceName", Value: "ai-workspace-web" },
    ]);
    // The threshold tracks the service floor, so it cannot drift from the
    // autoscaling minCapacity the stack declares.
    expect(properties.Threshold).toBe(webServiceMinCapacity());
  });

  it("keeps the unhealthy-host settings the retired script duplicate used", () => {
    expect(alarm("ai-workspace-web-unhealthy-hosts")).toMatchObject({
      AlarmActions: [opsTopicArn],
      OKActions: [opsTopicArn],
      MetricName: "UnHealthyHostCount",
      Statistic: "Maximum",
      Period: 60,
      EvaluationPeriods: 3,
      DatapointsToAlarm: 3,
      Threshold: 1,
      TreatMissingData: "notBreaching",
    });
  });

  it("leaves the unhealthy-host alarm to CDK alone (single owner)", () => {
    const script = readFileSync(
      join(ROOT, "infra/scripts/setup-ops-alarms.sh"),
      "utf8",
    );

    expect(script).not.toContain('--alarm-name "ai-workspace-web-unhealthy-hosts"');
    expect(script).not.toContain("UnHealthyHostCount");
    // The alarms the script still owns are untouched.
    expect(script).toContain("HTTPCode_Target_5XX_Count");
    expect(script).toContain("HTTPCode_ELB_5XX_Count");
    expect(script).toContain("--metric-name LiveTaskCount");
    expect(script).toContain("chat-run-worker-error");
  });
});

function webServiceMinCapacity(): number {
  const stack = readFileSync(
    join(ROOT, "infra/cdk/lib/ai-workspace-ecs-stack.ts"),
    "utf8",
  );
  const match = /const WEB_MIN_TASK_COUNT = (\d+);/.exec(stack);
  expect(match, "WEB_MIN_TASK_COUNT is missing").not.toBeNull();
  expect(stack).toContain("minCapacity: WEB_MIN_TASK_COUNT");
  return Number(match![1]);
}

function synthAlarms(): CloudFormationResource[] {
  const outputDir = mkdtempSync(join(tmpdir(), "ecs-cdk-synth-"));
  tempDirs.push(outputDir);
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "@ai-workspace/infra",
      "exec",
      "cdk",
      "synth",
      "AiWorkspaceEcsStack",
      "--exclusively",
      "--quiet",
      "--output",
      outputDir,
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        CDK_DEFAULT_ACCOUNT: "351478076796",
        CDK_DEFAULT_REGION: "us-east-1",
      },
    },
  );

  expect(result.status, result.stderr).toBe(0);
  const template = JSON.parse(
    readFileSync(join(outputDir, "AiWorkspaceEcsStack.template.json"), "utf8"),
  ) as { Resources: Record<string, CloudFormationResource> };
  return Object.values(template.Resources).filter(
    (resource) => resource.Type === "AWS::CloudWatch::Alarm",
  );
}

interface CloudFormationResource {
  Type: string;
  Properties?: {
    AlarmName?: string;
    AlarmActions?: unknown;
    Dimensions?: unknown;
    Threshold?: number;
    [key: string]: unknown;
  };
}

function metricQuery(id: string, metricName: string) {
  return expect.objectContaining({
    Id: id,
    MetricStat: {
      Metric: {
        Dimensions: [
          {
            Name: "ModelId",
            Value: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
          },
        ],
        MetricName: metricName,
        Namespace: "AWS/Bedrock",
      },
      Period: 86_400,
      Stat: "Sum",
    },
    ReturnData: false,
  });
}
