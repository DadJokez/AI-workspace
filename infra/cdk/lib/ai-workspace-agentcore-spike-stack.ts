import * as cdk from "aws-cdk-lib";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";

/**
 * AgentCore substrate spike (specs/003): ECR repo + execution role + the
 * Bedrock AgentCore Runtime hosting apps/agentcore-agent.
 *
 * `AWS::BedrockAgentCore::Runtime` is declared as a raw CfnResource so the
 * stack synthesizes on the repo's pinned aws-cdk-lib (2.195) without a CDK
 * upgrade — the L1 module for AgentCore shipped later.
 *
 * Two-step deploy (the runtime can't be created before its image exists):
 *   1. cdk deploy AiWorkspaceAgentCoreSpikeStack            → repo + role
 *   2. docker buildx build --platform linux/arm64 ... --push (see Dockerfile)
 *   3. cdk deploy AiWorkspaceAgentCoreSpikeStack \
 *        --parameters CreateRuntime=true                    → the runtime
 */
export class AiWorkspaceAgentCoreSpikeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const createRuntime = new cdk.CfnParameter(this, "CreateRuntime", {
      type: "String",
      allowedValues: ["true", "false"],
      default: "false",
      description:
        "Set to true only after the agent image has been pushed to ECR.",
    });
    const runtimeCondition = new cdk.CfnCondition(this, "RuntimeCondition", {
      expression: cdk.Fn.conditionEquals(createRuntime.valueAsString, "true"),
    });

    const repo = new ecr.Repository(this, "AgentImageRepo", {
      repositoryName: "ai-workspace-agentcore-agent",
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    const role = new iam.Role(this, "AgentRuntimeRole", {
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
      description:
        "Execution role for the AI Hub AgentCore Runtime spike: pull the agent image, call Bedrock models, write logs.",
    });
    repo.grantPull(role);
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "InvokeBedrockModels",
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        // Spike scope; tighten to the three Claude model ARNs before pilot.
        resources: ["*"],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "WriteLogs",
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogGroups",
          "logs:DescribeLogStreams",
        ],
        resources: [
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/*`,
        ],
      }),
    );

    const runtime = new cdk.CfnResource(this, "AgentRuntime", {
      type: "AWS::BedrockAgentCore::Runtime",
      properties: {
        // Name pattern is [a-zA-Z][a-zA-Z0-9_]{0,47} — no dashes.
        AgentRuntimeName: "ai_workspace_agent_spike",
        Description:
          "AI Hub agent loop (runAgentLoop + MCP tools) hosted on AgentCore — specs/003 spike.",
        AgentRuntimeArtifact: {
          ContainerConfiguration: {
            ContainerUri: `${repo.repositoryUri}:latest`,
          },
        },
        NetworkConfiguration: { NetworkMode: "PUBLIC" },
        ProtocolConfiguration: "HTTP",
        RoleArn: role.roleArn,
        EnvironmentVariables: {
          BEDROCK_CLIENT: "real",
        },
      },
    });
    runtime.cfnOptions.condition = runtimeCondition;
    runtime.node.addDependency(role);

    new cdk.CfnOutput(this, "AgentImageRepoUri", {
      value: repo.repositoryUri,
      description: "Push the linux/arm64 agent image here as :latest.",
    });
    new cdk.CfnOutput(this, "AgentRuntimeRoleArn", { value: role.roleArn });
    new cdk.CfnOutput(this, "AgentRuntimeArn", {
      value: cdk.Fn.conditionIf(
        runtimeCondition.logicalId,
        runtime.getAtt("AgentRuntimeArn").toString(),
        "not-created-yet",
      ).toString(),
      description:
        "Set this as AGENTCORE_RUNTIME_ARN (with RUNTIME=agentcore) on the web/chat-worker services.",
    });
  }
}
