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

describe("AiWorkspaceDeployTasksStack", () => {
  let template: CloudFormationTemplate;

  beforeAll(() => {
    template = synthStack();
  }, 300_000);

  it("pins migration and smoke tasks to the requested immutable images", () => {
    const taskDefinitions = resourcesOfType(
      template,
      "AWS::ECS::TaskDefinition",
    );
    expect(taskDefinitions).toHaveLength(2);

    const migrator = taskDefinitions.find(
      (resource) => resource.Properties?.Family === "ai-workspace-migrator",
    );
    const smoke = taskDefinitions.find(
      (resource) =>
        resource.Properties?.Family === "ai-workspace-production-smoke",
    );
    expect(JSON.stringify(migrator)).toContain("/ai-workspace:migrator-");
    expect(JSON.stringify(smoke)).toContain("/ai-workspace:worker-");
    expect(JSON.stringify(migrator)).toContain("DATABASE_URL");
    expect(JSON.stringify(migrator)).not.toContain("NEXTAUTH_SECRET");
    expect(JSON.stringify(smoke)).toContain("DATABASE_URL");
    expect(JSON.stringify(smoke)).toContain("NEXTAUTH_SECRET");
    expect(JSON.stringify(smoke)).toContain("smoke:prod:auth");
  });

  it("allows only the deploy-task security group to reach Postgres", () => {
    const ingress = resourcesOfType(
      template,
      "AWS::EC2::SecurityGroupIngress",
    );
    expect(ingress).toContainEqual(
      expect.objectContaining({
        Properties: expect.objectContaining({
          Description: "AI Workspace deploy tasks access Postgres",
          FromPort: 5432,
          GroupId: "sg-019e87b5938a295a4",
          IpProtocol: "tcp",
          SourceSecurityGroupId: expect.any(Object),
          ToPort: 5432,
        }),
      }),
    );
    expect(JSON.stringify(ingress)).not.toContain("0.0.0.0/0");
  });

  it("cleans up new log groups on create rollback but retains established logs", () => {
    const logGroups = resourcesOfType(template, "AWS::Logs::LogGroup");
    expect(logGroups).toHaveLength(2);
    expect(logGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          DeletionPolicy: "RetainExceptOnCreate",
          UpdateReplacePolicy: "Retain",
        }),
        expect.objectContaining({
          DeletionPolicy: "RetainExceptOnCreate",
          UpdateReplacePolicy: "Retain",
        }),
      ]),
    );
  });

  it("grants CodeBuild only task launch, receipt, and scoped pass-role access", () => {
    const codeBuildPolicies = Object.entries(template.Resources).filter(
      ([logicalId, resource]) =>
        logicalId.startsWith("CodeBuildDeployTaskPolicy") &&
        resource.Type === "AWS::IAM::Policy",
    );
    expect(codeBuildPolicies).toHaveLength(1);
    expect(
      Object.keys(template.Resources).filter((logicalId) =>
        logicalId.startsWith("CodeBuildAiWorkspaceRolePolicy"),
      ),
    ).toEqual([]);

    const statements =
      codeBuildPolicies[0]?.[1].Properties?.PolicyDocument?.Statement ?? [];
    const runTask = statements.find(
      (statement) => statement.Action === "ecs:RunTask",
    );
    expect(runTask?.Resource).toHaveLength(2);
    expect(
      statements.find((statement) => statement.Action === "ecs:DescribeTasks"),
    ).toMatchObject({ Effect: "Allow", Resource: "*" });
    const passRole = statements.find(
      (statement) => statement.Action === "iam:PassRole",
    );
    expect(passRole?.Condition).toEqual({
      StringLike: { "iam:PassedToService": "ecs-tasks.amazonaws.com" },
    });
    expect(passRole?.Resource).toHaveLength(4);
    expect(passRole?.Resource).not.toBe("*");
  });

  it("publishes the task and network identifiers used by the runner", () => {
    expect(template.Outputs).toEqual(
      expect.objectContaining({
        MigratorTaskDefinitionArn: expect.any(Object),
        ProductionSmokeTaskDefinitionArn: expect.any(Object),
        DeployTaskSecurityGroupId: expect.any(Object),
        DeployTaskSubnetIds: expect.any(Object),
      }),
    );
  });
});

function synthStack(): CloudFormationTemplate {
  const outputDir = mkdtempSync(join(tmpdir(), "deploy-tasks-cdk-synth-"));
  tempDirs.push(outputDir);
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "@ai-workspace/infra",
      "exec",
      "cdk",
      "synth",
      "AiWorkspaceDeployTasksStack",
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
  return JSON.parse(
    readFileSync(
      join(outputDir, "AiWorkspaceDeployTasksStack.template.json"),
      "utf8",
    ),
  ) as CloudFormationTemplate;
}

function resourcesOfType(template: CloudFormationTemplate, type: string) {
  return Object.values(template.Resources).filter(
    (resource) => resource.Type === type,
  );
}

interface CloudFormationTemplate {
  Resources: Record<string, CloudFormationResource>;
  Outputs: Record<string, unknown>;
}

interface CloudFormationResource {
  DeletionPolicy?: string;
  Type: string;
  UpdateReplacePolicy?: string;
  Properties?: {
    Family?: string;
    PolicyDocument?: { Statement: PolicyStatement[] };
    [key: string]: unknown;
  };
}

interface PolicyStatement {
  Action?: string | string[];
  Condition?: unknown;
  Effect?: string;
  Resource?: unknown[] | string;
}
