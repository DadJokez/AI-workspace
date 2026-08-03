import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

export class AiWorkspaceDeployTasksStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const imageTag = new cdk.CfnParameter(this, "ImageTag", {
      type: "String",
      default: "latest",
      description:
        "Immutable ECR image tag used by the migration and production-smoke tasks.",
    });
    const repository = ecr.Repository.fromRepositoryName(
      this,
      "AiWorkspaceRepository",
      contextString(
        this,
        "aiWorkspace:ecrRepositoryName",
        "ai-workspace",
      ),
    );
    const appSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "AppSecret",
      contextString(
        this,
        "aiWorkspace:appSecretName",
        "ai-workspace/production/app",
      ),
    );
    const vpc = ec2.Vpc.fromLookup(this, "DefaultVpc", { isDefault: true });
    const databaseSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      "DatabaseSecurityGroup",
      contextString(
        this,
        "aiWorkspace:dbSecurityGroupId",
        "sg-019e87b5938a295a4",
      ),
      { mutable: true },
    );
    const deployTaskSecurityGroup = new ec2.SecurityGroup(
      this,
      "DeployTaskSecurityGroup",
      {
        vpc,
        description: "AI Workspace one-off migration and smoke tasks",
        allowAllOutbound: true,
      },
    );
    databaseSecurityGroup.addIngressRule(
      deployTaskSecurityGroup,
      ec2.Port.tcp(5432),
      "AI Workspace deploy tasks access Postgres",
    );

    const migrationLogGroup = new logs.LogGroup(this, "MigrationLogGroup", {
      logGroupName: "/ecs/ai-workspace/migrator",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
    });
    const smokeLogGroup = new logs.LogGroup(this, "SmokeLogGroup", {
      logGroupName: "/ecs/ai-workspace/production-smoke",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
    });

    const migratorTask = new ecs.FargateTaskDefinition(this, "MigratorTask", {
      family: "ai-workspace-migrator",
      cpu: 256,
      memoryLimitMiB: 512,
    });
    migratorTask.addContainer("migrator", {
      containerName: "migrator",
      image: ecs.ContainerImage.fromEcrRepository(
        repository,
        `migrator-${imageTag.valueAsString}`,
      ),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "migrator",
        logGroup: migrationLogGroup,
      }),
      secrets: {
        DATABASE_URL: ecs.Secret.fromSecretsManager(appSecret, "DATABASE_URL"),
      },
    });

    const smokeTask = new ecs.FargateTaskDefinition(
      this,
      "ProductionSmokeTask",
      {
        family: "ai-workspace-production-smoke",
        cpu: 256,
        memoryLimitMiB: 512,
      },
    );
    smokeTask.addContainer("production-smoke", {
      containerName: "production-smoke",
      image: ecs.ContainerImage.fromEcrRepository(
        repository,
        `worker-${imageTag.valueAsString}`,
      ),
      command: [
        "pnpm",
        "--filter",
        "@ai-workspace/web",
        "smoke:prod:auth",
      ],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "production-smoke",
        logGroup: smokeLogGroup,
      }),
      environment: {
        SMOKE_BASE_URL: contextString(
          this,
          "aiWorkspace:smokeBaseUrl",
          "https://comparative.builtwithrobot.link",
        ),
        SMOKE_RUN_ID: imageTag.valueAsString,
      },
      secrets: {
        DATABASE_URL: ecs.Secret.fromSecretsManager(appSecret, "DATABASE_URL"),
        NEXTAUTH_SECRET: ecs.Secret.fromSecretsManager(
          appSecret,
          "NEXTAUTH_SECRET",
        ),
      },
    });

    const codeBuildRoleArn = contextString(
      this,
      "aiWorkspace:codeBuildRoleArn",
      "",
    );
    if (codeBuildRoleArn) {
      const codeBuildRole = iam.Role.fromRoleArn(
        this,
        "CodeBuildAiWorkspaceRole",
        codeBuildRoleArn,
        { mutable: true },
      );
      const codeBuildDeployTaskPolicy = new iam.Policy(
        this,
        "CodeBuildDeployTaskPolicy",
        {
          statements: [
            new iam.PolicyStatement({
              actions: ["ecs:RunTask"],
              resources: [
                migratorTask.taskDefinitionArn,
                smokeTask.taskDefinitionArn,
              ],
            }),
            new iam.PolicyStatement({
              actions: ["iam:PassRole"],
              resources: [
                migratorTask.taskRole.roleArn,
                migratorTask.obtainExecutionRole().roleArn,
                smokeTask.taskRole.roleArn,
                smokeTask.obtainExecutionRole().roleArn,
              ],
              conditions: {
                StringLike: {
                  "iam:PassedToService": "ecs-tasks.amazonaws.com",
                },
              },
            }),
            new iam.PolicyStatement({
              actions: ["ecs:DescribeTasks"],
              resources: ["*"],
            }),
            new iam.PolicyStatement({
              actions: ["cloudformation:DescribeStacks"],
              resources: [this.stackId],
            }),
          ],
        },
      );
      codeBuildDeployTaskPolicy.attachToRole(codeBuildRole);
    }

    new cdk.CfnOutput(this, "MigratorTaskDefinitionArn", {
      value: migratorTask.taskDefinitionArn,
    });
    new cdk.CfnOutput(this, "ProductionSmokeTaskDefinitionArn", {
      value: smokeTask.taskDefinitionArn,
    });
    new cdk.CfnOutput(this, "DeployTaskSecurityGroupId", {
      value: deployTaskSecurityGroup.securityGroupId,
    });
    new cdk.CfnOutput(this, "DeployTaskSubnetIds", {
      value: vpc.publicSubnets.map((subnet) => subnet.subnetId).join(","),
    });
  }
}

function contextString(
  stack: cdk.Stack,
  key: string,
  fallback: string,
): string {
  const value = stack.node.tryGetContext(key);
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;
}
