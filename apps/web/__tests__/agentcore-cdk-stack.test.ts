import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("AiWorkspaceAgentCoreSpikeStack", () => {
  it("owns a dedicated ARM child project with narrowly scoped deploy permissions", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "agentcore-cdk-synth-"));
    tempDirs.push(outputDir);
    const result = spawnSync(
      "pnpm",
      [
        "--filter",
        "@ai-workspace/infra",
        "exec",
        "cdk",
        "synth",
        "AiWorkspaceAgentCoreSpikeStack",
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
      readFileSync(
        join(outputDir, "AiWorkspaceAgentCoreSpikeStack.template.json"),
        "utf8",
      ),
    ) as CloudFormationTemplate;
    const resources = Object.values(template.Resources);
    const childProject = resources.find(
      (resource) =>
        resource.Type === "AWS::CodeBuild::Project" &&
        resource.Properties?.Name === "ai-workspace-agentcore-build",
    );

    expect(childProject).toBeDefined();
    expect(childProject?.Properties).toMatchObject({
      Artifacts: { Type: "NO_ARTIFACTS" },
      BadgeEnabled: false,
      ConcurrentBuildLimit: 1,
      Environment: {
        ComputeType: "BUILD_GENERAL1_MEDIUM",
        Image: "aws/codebuild/amazonlinux-aarch64-standard:3.0",
        ImagePullCredentialsType: "CODEBUILD",
        PrivilegedMode: true,
        Type: "ARM_CONTAINER",
      },
      QueuedTimeoutInMinutes: 30,
      Source: {
        BuildSpec: "buildspec.agentcore.yml",
        GitCloneDepth: 1,
        InsecureSsl: false,
        Location: "https://github.com/DadJokez/AI-workspace.git",
        ReportBuildStatus: false,
        Type: "GITHUB",
      },
      TimeoutInMinutes: 30,
    });
    expect(
      childProject?.Properties?.Source as Record<string, unknown>,
    ).not.toHaveProperty("Auth");

    const statements = resources.flatMap(
      (resource) =>
        resource.Properties?.PolicyDocument?.Statement ??
        resource.Properties?.Policies?.flatMap(
          (policy) => policy.PolicyDocument.Statement,
        ) ??
        [],
    );
    const childBuildStatement = statements.find(
      (statement) => statement.Sid === "RunNativeArmAgentCoreImageBuild",
    );
    const describeImageStatement = statements.find(
      (statement) => statement.Sid === "DescribeAgentCoreImage",
    );

    expect(childBuildStatement?.Action).toEqual([
      "codebuild:StartBuild",
      "codebuild:BatchGetBuilds",
    ]);
    expect(JSON.stringify(childBuildStatement?.Resource)).toContain(
      "AgentCoreImageBuild",
    );
    expect(JSON.stringify(childBuildStatement?.Resource)).not.toContain(
      "ai-workspace-build",
    );
    expect(describeImageStatement?.Action).toBe("ecr:DescribeImages");
    expect(JSON.stringify(describeImageStatement?.Resource)).toContain(
      "AgentImageRepo",
    );
  });
});

interface CloudFormationTemplate {
  Resources: Record<
    string,
    {
      Type: string;
      Properties?: {
        Name?: string;
        Policies?: Array<{
          PolicyDocument: { Statement: PolicyStatement[] };
        }>;
        PolicyDocument?: { Statement: PolicyStatement[] };
        [key: string]: unknown;
      };
    }
  >;
}

interface PolicyStatement {
  Action?: string | string[];
  Resource?: unknown;
  Sid?: string;
}
