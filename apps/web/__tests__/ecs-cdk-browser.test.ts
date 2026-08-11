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

describe("AiWorkspaceEcsStack AgentCore Browser", () => {
  let browser: CloudFormationResource;

  beforeAll(() => {
    const resources = synthResources();
    const browsers = resources.filter(
      (resource) => resource.Type === "AWS::BedrockAgentCore::BrowserCustom",
    );
    expect(browsers).toHaveLength(1);
    browser = browsers[0]!;
  }, 300_000);

  it("uses only AgentCore-supported production availability zones", () => {
    expect(browser.Properties?.NetworkConfiguration).toMatchObject({
      NetworkMode: "VPC",
      VpcConfig: {
        Subnets: [
          "subnet-01296edbe2fad6965",
          "subnet-0f17f1cc59fa04c0d",
          "subnet-0ad7f1f0027d97361",
        ],
      },
    });
  });
});

function synthResources(): CloudFormationResource[] {
  const outputDir = mkdtempSync(join(tmpdir(), "ecs-cdk-browser-synth-"));
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
  return Object.values(template.Resources);
}

interface CloudFormationResource {
  Type: string;
  Properties?: {
    NetworkConfiguration?: unknown;
    [key: string]: unknown;
  };
}
