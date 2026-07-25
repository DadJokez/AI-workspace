import * as cdk from "aws-cdk-lib";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
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
        "Commit-SHA ECR tag deployed to the AgentCore runtime. CodeBuild updates this parameter after pushing the image. The repository accepts MUTABLE tags, so uniqueness is a deployment convention, not a registry guarantee.",
    });
    const appSecretName = new cdk.CfnParameter(this, "AppSecretName", {
      type: "String",
      default: "ai-workspace/production/app",
      description:
        "Secrets Manager JSON secret containing BRAVE_SEARCH_API_KEY.",
    });
    const deploymentSequence = new cdk.CfnParameter(
      this,
      "DeploymentSequence",
      {
        type: "Number",
        default: 0,
        minValue: 0,
        description:
          "Monotonic CodeBuild build number used to reject superseded deployments.",
      },
    );
    const sourceTemplateSha256 = new cdk.CfnParameter(
      this,
      "SourceTemplateSha256",
      {
        type: "String",
        default: "0".repeat(64),
        allowedPattern: "[a-f0-9]{64}",
        description:
          "SHA-256 of the synthesized source template submitted for this deployment.",
      },
    );
    new cdk.CfnOutput(this, "DeployedSequence", {
      value: deploymentSequence.valueAsString,
      description: "CodeBuild sequence that last reconciled this stack.",
    });
    new cdk.CfnOutput(this, "DeployedSourceTemplateSha256", {
      value: sourceTemplateSha256.valueAsString,
      description:
        "SHA-256 of the source template submitted by the last deployment.",
    });
    const braveCredentialProviderName = "comparative-brave-search";

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
    const braveCredentialProvider = new cdk.CfnResource(
      this,
      "BraveSearchCredentialProvider",
      {
        type: "AWS::BedrockAgentCore::ApiKeyCredentialProvider",
        properties: {
          Name: braveCredentialProviderName,
          ApiKeySecretSource: "EXTERNAL",
          ApiKeySecretConfig: {
            SecretId: appSecretName.valueAsString,
            JsonKey: "BRAVE_SEARCH_API_KEY",
          },
          Tags: [
            { Key: "Application", Value: "Comparative" },
            { Key: "Purpose", Value: "WebSearch" },
          ],
        },
      },
    );
    repo.grantPull(role);
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "InvokeBedrockModels",
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        // Spike scope; tighten to the three Claude model ARNs before pilot.
        resources: ["*"],
      }),
    );
    const workloadIdentityDirectoryArn = this.formatArn({
      service: "bedrock-agentcore",
      resource: "workload-identity-directory",
      resourceName: "default",
      arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    });
    const tokenVaultArn = this.formatArn({
      service: "bedrock-agentcore",
      resource: "token-vault",
      resourceName: "default",
      arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadBraveSearchCredential",
        actions: ["bedrock-agentcore:GetResourceApiKey"],
        resources: [
          workloadIdentityDirectoryArn,
          `${workloadIdentityDirectoryArn}/workload-identity/ai_workspace_agent_spike-*`,
          tokenVaultArn,
          braveCredentialProvider
            .getAtt("CredentialProviderArn")
            .toString(),
        ],
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
          WEB_SEARCH_PROVIDER: "brave",
          BRAVE_SEARCH_CREDENTIAL_PROVIDER: braveCredentialProviderName,
          // The in-container Bedrock client resolves AWS_REGION ??
          // AWS_DEFAULT_REGION; set the fallback explicitly in case the
          // runtime does not inject AWS_REGION.
          AWS_DEFAULT_REGION: this.region,
        },
      },
    });
    runtime.cfnOptions.condition = runtimeCondition;
    runtime.node.addDependency(role);
    runtime.node.addDependency(braveCredentialProvider);

    // CloudFormation remains the sole owner of the runtime. CodeBuild submits
    // the current synthesized template and the commit-SHA image tag together,
    // so reviewed infrastructure changes cannot remain source-only. The tag
    // is not registry-immutable — `ai-workspace-agentcore-agent` is a MUTABLE
    // ECR repository and `buildspec.agentcore.yml` also pushes `:latest`.
    // `ContainerUri` above therefore carries a tag, not a digest;
    // update-agentcore-stack.sh separately resolves that tag to a sha256
    // digest and records it in the deployment receipt, so the receipt stays
    // digest-accurate even though the template reference is by tag (#449).
    const codeBuildRole = iam.Role.fromRoleName(
      this,
      "CodeBuildDeploymentRole",
      "CodeBuildAIWorkspaceRole",
    );
    const agentCoreImageBuild = new codebuild.CfnProject(
      this,
      "AgentCoreImageBuild",
      {
        name: "ai-workspace-agentcore-build",
        description:
          "Dedicated native ARM64 image builder for the Comparative AgentCore runtime.",
        serviceRole: codeBuildRole.roleArn,
        artifacts: { type: "NO_ARTIFACTS" },
        source: {
          type: "GITHUB",
          location: "https://github.com/DadJokez/AI-workspace.git",
          gitCloneDepth: 1,
          buildSpec: "buildspec.agentcore.yml",
          reportBuildStatus: false,
          insecureSsl: false,
        },
        environment: {
          type: "ARM_CONTAINER",
          image: "aws/codebuild/amazonlinux-aarch64-standard:3.0",
          computeType: "BUILD_GENERAL1_MEDIUM",
          privilegedMode: true,
          imagePullCredentialsType: "CODEBUILD",
        },
        cache: { type: "NO_CACHE" },
        timeoutInMinutes: 30,
        queuedTimeoutInMinutes: 30,
        concurrentBuildLimit: 1,
        badgeEnabled: false,
        tags: [
          { key: "Application", value: "Comparative" },
          { key: "Purpose", value: "AgentCoreImageBuild" },
        ],
      },
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
            resources: [agentCoreImageBuild.attrArn],
          }),
          new iam.PolicyStatement({
            sid: "DescribeAgentCoreImage",
            actions: ["ecr:DescribeImages"],
            resources: [repo.repositoryArn],
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
          actions: [
            "bedrock-agentcore:InvokeAgentRuntime",
            "bedrock-agentcore:InvokeAgentRuntimeForUser",
          ],
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
    new cdk.CfnOutput(this, "AgentCoreImageBuildProjectName", {
      value: agentCoreImageBuild.ref,
      description:
        "Dedicated native ARM64 CodeBuild child used by the production deployment.",
    });
    new cdk.CfnOutput(this, "AgentRuntimeRoleArn", { value: role.roleArn });
    new cdk.CfnOutput(this, "BraveSearchCredentialProviderArn", {
      value: braveCredentialProvider
        .getAtt("CredentialProviderArn")
        .toString(),
    });
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
