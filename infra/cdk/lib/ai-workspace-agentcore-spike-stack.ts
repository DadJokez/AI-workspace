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
    const agentImageTag = new cdk.CfnParameter(this, "AgentImageTag", {
      type: "String",
      default: "latest",
      description:
        "Immutable ECR tag deployed to the AgentCore runtime. CodeBuild updates this parameter after pushing the image.",
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
        sid: "ValidateMarketplaceSubscriptions",
        // Bedrock validates Marketplace-subscribed models (Anthropic) against
        // the *invoking* role; AmazonBedrockFullAccess carries the same pair.
        actions: [
          "aws-marketplace:ViewSubscriptions",
          "aws-marketplace:Subscribe",
        ],
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
            ContainerUri: `${repo.repositoryUri}:${agentImageTag.valueAsString}`,
          },
        },
        NetworkConfiguration: { NetworkMode: "PUBLIC" },
        ProtocolConfiguration: "HTTP",
        RoleArn: role.roleArn,
        EnvironmentVariables: {
          BEDROCK_CLIENT: "real",
          // The in-container Bedrock client resolves AWS_REGION ??
          // AWS_DEFAULT_REGION; set the fallback explicitly in case the
          // runtime does not inject AWS_REGION.
          AWS_DEFAULT_REGION: this.region,
        },
      },
    });
    runtime.cfnOptions.condition = runtimeCondition;
    runtime.node.addDependency(role);

    // CloudFormation remains the sole owner of the runtime. CodeBuild updates
    // only AgentImageTag on this stack after pushing an immutable image, so a
    // later CDK deploy cannot silently restore a stale out-of-band version.
    const codeBuildRole = iam.Role.fromRoleName(
      this,
      "CodeBuildDeploymentRole",
      "CodeBuildAIWorkspaceRole",
    );
    const codeBuildDeployPolicy = new iam.Policy(
      this,
      "CodeBuildAgentCoreDeployment",
      {
        statements: [
          new iam.PolicyStatement({
            sid: "UpdateAgentCoreStack",
            actions: [
              "cloudformation:DescribeStacks",
              "cloudformation:DescribeStackEvents",
              "cloudformation:UpdateStack",
            ],
            resources: [
              this.formatArn({
                service: "cloudformation",
                resource: "stack",
                resourceName: `${this.stackName}/*`,
                arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
              }),
            ],
          }),
          new iam.PolicyStatement({
            sid: "RunNativeArmAgentCoreImageBuild",
            actions: ["codebuild:StartBuild", "codebuild:BatchGetBuilds"],
            resources: [
              this.formatArn({
                service: "codebuild",
                resource: "project",
                resourceName: "ai-workspace-build",
                arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
              }),
            ],
          }),
          new iam.PolicyStatement({
            sid: "UpdateComparativeAgentCoreRuntime",
            actions: [
              "bedrock-agentcore:GetAgentRuntime",
              "bedrock-agentcore:UpdateAgentRuntime",
            ],
            resources: [runtime.getAtt("AgentRuntimeArn").toString()],
          }),
          new iam.PolicyStatement({
            sid: "PassComparativeAgentCoreRuntimeRole",
            actions: ["iam:PassRole"],
            resources: [role.roleArn],
            conditions: {
              StringEquals: {
                "iam:PassedToService": "bedrock-agentcore.amazonaws.com",
              },
            },
          }),
        ],
      },
    );
    codeBuildDeployPolicy.attachToRole(codeBuildRole);
    (
      codeBuildDeployPolicy.node.defaultChild as iam.CfnPolicy
    ).cfnOptions.condition = runtimeCondition;

    // T310: let the production web and chat-worker tasks invoke the
    // runtime. Roles are imported by their deployed names so the ECS stack
    // (and its services) stay untouched; the lane flip is then just
    // RUNTIME=agentcore + AGENTCORE_RUNTIME_ARN on the task env.
    const invokePolicy = new iam.ManagedPolicy(this, "InvokeAgentRuntime", {
      description:
        "Allows AI Hub services to invoke the AgentCore spike runtime.",
      statements: [
        new iam.PolicyStatement({
          actions: ["bedrock-agentcore:InvokeAgentRuntime"],
          resources: [
            runtime.getAtt("AgentRuntimeArn").toString(),
            `${runtime.getAtt("AgentRuntimeArn").toString()}/*`,
          ],
        }),
      ],
    });
    // The policy references the conditional runtime's ARN, so it must ride
    // the same condition or a CreateRuntime=false synth fails to resolve.
    (invokePolicy.node.defaultChild as cdk.CfnResource).cfnOptions.condition =
      runtimeCondition;
    for (const roleName of [
      "AiWorkspaceEcsStack-WebTaskTaskRole6A095794-XVAIzdk8uogj",
      "AiWorkspaceEcsStack-aiworkspacechatworkerTaskTaskRo-vEUnoDimrRUg",
    ]) {
      invokePolicy.attachToRole(
        iam.Role.fromRoleName(this, `Grant${roleName.slice(-12)}`, roleName),
      );
    }

    new cdk.CfnOutput(this, "AgentImageRepoUri", {
      value: repo.repositoryUri,
      description:
        "Push the linux/arm64 agent image here, then update AgentImageTag through CloudFormation.",
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
