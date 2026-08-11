import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";

const APP_SECRET_FIELDS = [
  "DATABASE_URL",
  "NEXTAUTH_SECRET",
  "GITHUB_AUTH_CLIENT_ID",
  "GITHUB_AUTH_CLIENT_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "NOTION_CLIENT_ID",
  "NOTION_CLIENT_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "SALESFORCE_CLIENT_ID",
  "SALESFORCE_CLIENT_SECRET",
  "OAUTH_ENCRYPTION_KEY",
  "WEB_SEARCH_PROVIDER",
  "BRAVE_SEARCH_API_KEY",
] as const;

const WORKER_TASK_SIZE = {
  cpu: 256,
  memoryLimitMiB: 512,
} as const;

/**
 * The production availability floor for the web service. Autoscaling's
 * minCapacity and the #568 liveness alarm threshold both read this constant so
 * the alarm cannot silently drift away from the declared floor.
 */
const WEB_MIN_TASK_COUNT = 2;
const CLUSTER_NAME = "ai-workspace-prod";
const WEB_SERVICE_NAME = "ai-workspace-web";
const BEDROCK_SONNET_45_MODEL_ID =
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const BEDROCK_SONNET_45_DAILY_TOKEN_QUOTA = 5_400_000;
const BEDROCK_DAILY_TOKEN_WARNING_THRESHOLD =
  BEDROCK_SONNET_45_DAILY_TOKEN_QUOTA * 0.8;

export class AiWorkspaceEcsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // #449: immutable image deploys. The pipeline passes the commit tag so
    // task definitions pin the exact image that was built; "latest" remains
    // only as the default for manual/console deploys. Mirrors the AgentCore
    // stack's AgentImageTag parameter.
    const imageTag = new cdk.CfnParameter(this, "ImageTag", {
      type: "String",
      default: "latest",
      description:
        "ECR image tag suffix to deploy (commit SHA in CI; 'latest' only for manual deploys). Workers use worker-<tag>/memory-worker-<tag>.",
    });

    const domainName = contextString(
      this,
      "aiWorkspace:domainName",
      "comparative.builtwithrobot.link",
    );
    const legacyDomainName = contextString(
      this,
      "aiWorkspace:legacyDomainName",
      "ai-workspace.builtwithrobot.link",
    );
    const hostedZoneName = contextString(
      this,
      "aiWorkspace:hostedZoneName",
      "builtwithrobot.link",
    );
    const ecrRepositoryName = contextString(
      this,
      "aiWorkspace:ecrRepositoryName",
      "ai-workspace",
    );
    const appSecretName = contextString(
      this,
      "aiWorkspace:appSecretName",
      "ai-workspace/production/app",
    );
    const inviteEmailIdentityName = contextString(
      this,
      "aiWorkspace:inviteEmailIdentityName",
      "comparative.builtwithrobot.link",
    );
    const inviteEmailProvider = contextString(
      this,
      "aiWorkspace:inviteEmailProvider",
      "ses",
    );
    const inviteEmailFrom = contextString(
      this,
      "aiWorkspace:inviteEmailFrom",
      "no-reply@comparative.builtwithrobot.link",
    );
    const inviteEmailAwsRegion = contextString(
      this,
      "aiWorkspace:inviteEmailAwsRegion",
      cdk.Stack.of(this).region,
    );
    const dbSecurityGroupId = contextString(
      this,
      "aiWorkspace:dbSecurityGroupId",
      "sg-019e87b5938a295a4",
    );
    const codeBuildRoleArn = contextString(
      this,
      "aiWorkspace:codeBuildRoleArn",
      "",
    );
    const albAccessLogBucketName = contextString(
      this,
      "aiWorkspace:albAccessLogBucketName",
      `ai-workspace-alb-logs-${this.account}-${this.region}`,
    );
    // The ops topic and its confirmed email subscription are created by
    // infra/scripts/setup-ops-alarms.sh (an operator confirms the subscription
    // out of band), so the stack references it by name instead of creating it.
    const opsAlertTopicName = contextString(
      this,
      "aiWorkspace:opsAlertTopicName",
      "ai-workspace-ops-alerts",
    );
    const opsAlertTopic = sns.Topic.fromTopicArn(
      this,
      "OpsAlertTopic",
      `arn:${this.partition}:sns:${this.region}:${this.account}:${opsAlertTopicName}`,
    );
    const opsAlertAction = new cloudwatchActions.SnsAction(opsAlertTopic);

    const vpc = ec2.Vpc.fromLookup(this, "DefaultVpc", {
      isDefault: true,
    });
    const hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
      domainName: hostedZoneName,
    });
    const repository = ecr.Repository.fromRepositoryName(
      this,
      "AiWorkspaceRepository",
      ecrRepositoryName,
    );
    const appSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "AppSecret",
      appSecretName,
    );

    const certificate = new acm.Certificate(this, "Certificate", {
      domainName,
      subjectAlternativeNames:
        legacyDomainName !== domainName ? [legacyDomainName] : undefined,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });
    const serviceRecordDomainName =
      legacyDomainName !== domainName ? legacyDomainName : domainName;

    const cluster = new ecs.Cluster(this, "Cluster", {
      clusterName: CLUSTER_NAME,
      vpc,
      containerInsightsV2: ecs.ContainerInsights.DISABLED,
    });

    const webSecurityGroup = new ec2.SecurityGroup(this, "WebSecurityGroup", {
      vpc,
      description: "AI Workspace web service",
      allowAllOutbound: true,
    });
    const workerSecurityGroup = new ec2.SecurityGroup(
      this,
      "WorkerSecurityGroup",
      {
        vpc,
        description: "AI Workspace background workers",
        allowAllOutbound: true,
      },
    );
    const databaseSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      "DatabaseSecurityGroup",
      dbSecurityGroupId,
      { mutable: true },
    );
    databaseSecurityGroup.addIngressRule(
      webSecurityGroup,
      ec2.Port.tcp(5432),
      "AI Workspace web tasks access Postgres",
    );
    databaseSecurityGroup.addIngressRule(
      workerSecurityGroup,
      ec2.Port.tcp(5432),
      "AI Workspace worker tasks access Postgres",
    );

    const commonEnvironment = {
      NODE_ENV: "production",
      AWS_REGION: cdk.Stack.of(this).region,
      BEDROCK_CLIENT: "real",
      RUNTIME: "bedrock",
      RUNTIME_V2_ENABLED: "1",
      // Model-decided routing (#364, sole engine since the regex path was
      // deleted) selects the lane model itself; keep the direct-mode
      // fallback on autopilot.
      RUNTIME_V2_DIRECT_MODEL_ID: "auto",
      NEXTAUTH_URL: `https://${domainName}`,
      LEGACY_HOST_REDIRECT_FROM:
        legacyDomainName !== domainName ? legacyDomainName : "",
      HOSTNAME: "0.0.0.0",
      PORT: "3000",
    };
    const commonSecrets = Object.fromEntries(
      APP_SECRET_FIELDS.map((field) => [
        field,
        ecs.Secret.fromSecretsManager(appSecret, field),
      ]),
    );
    const webSecrets = {
      ...commonSecrets,
      GITHUB_WEBHOOK_SECRET: ecs.Secret.fromSecretsManager(
        appSecret,
        "GITHUB_WEBHOOK_SECRET",
      ),
    };

    const webLogGroup = new logs.LogGroup(this, "WebLogGroup", {
      logGroupName: "/ecs/ai-workspace/web",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const chatWorkerLogGroup = new logs.LogGroup(this, "ChatWorkerLogGroup", {
      logGroupName: "/ecs/ai-workspace/chat-worker",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const memoryWorkerLogGroup = new logs.LogGroup(
      this,
      "MemoryWorkerLogGroup",
      {
        logGroupName: "/ecs/ai-workspace/memory-worker",
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );

    const webTask = new ecs.FargateTaskDefinition(this, "WebTask", {
      family: "ai-workspace-web",
      cpu: 512,
      memoryLimitMiB: 1024,
    });
    grantBedrockInvoke(webTask);
    grantSesSendEmail(webTask, inviteEmailIdentityName, inviteEmailAwsRegion);
    webTask.addContainer("web", {
      image: ecs.ContainerImage.fromEcrRepository(repository, imageTag.valueAsString),
      containerName: "web",
      portMappings: [{ containerPort: 3000 }],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "web",
        logGroup: webLogGroup,
      }),
      environment: {
        ...commonEnvironment,
        CHAT_RUN_IN_PROCESS_WORKER: "0",
        MEMORY_CAPTURE_IN_PROCESS_SCHEDULER: "0",
        INVITE_EMAIL_PROVIDER: inviteEmailProvider,
        INVITE_EMAIL_FROM: inviteEmailFrom,
        INVITE_EMAIL_AWS_REGION: inviteEmailAwsRegion,
      },
      secrets: webSecrets,
    });

    const webService =
      new ecsPatterns.ApplicationLoadBalancedFargateService(
        this,
        "WebService",
        {
          cluster,
          serviceName: WEB_SERVICE_NAME,
          taskDefinition: webTask,
          publicLoadBalancer: true,
          assignPublicIp: true,
          securityGroups: [webSecurityGroup],
          taskSubnets: { subnetType: ec2.SubnetType.PUBLIC },
          domainName: serviceRecordDomainName,
          domainZone: hostedZone,
          certificate,
          redirectHTTP: true,
          loadBalancerName: "ai-workspace",
          circuitBreaker: { rollback: true },
          minHealthyPercent: 100,
        },
      );
    webService.loadBalancer.setAttribute("access_logs.s3.enabled", "true");
    webService.loadBalancer.setAttribute(
      "access_logs.s3.bucket",
      albAccessLogBucketName,
    );
    webService.loadBalancer.setAttribute("access_logs.s3.prefix", "alb");
    webService.targetGroup.configureHealthCheck({
      path: "/api/health",
      healthyHttpCodes: "200",
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(10),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
    });
    webService.targetGroup.setAttribute(
      "deregistration_delay.timeout_seconds",
      "30",
    );
    webService.service.connections.allowFrom(
      webService.loadBalancer,
      ec2.Port.tcp(3000),
    );
    webService.service.node.addDependency(certificate);

    const webScaling = webService.service.autoScaleTaskCount({
      minCapacity: WEB_MIN_TASK_COUNT,
      maxCapacity: 4,
    });
    webScaling.scaleOnCpuUtilization("WebCpuScaling", {
      targetUtilizationPercent: 60,
      scaleOutCooldown: cdk.Duration.seconds(60),
      scaleInCooldown: cdk.Duration.minutes(5),
    });
    // Application Auto Scaling owns live capacity. Omitting DesiredCount keeps
    // a routine stack deployment from scaling a busy service back to the floor.
    const cfnWebService = webService.service.node.defaultChild as ecs.CfnService;
    cfnWebService.addPropertyDeletionOverride("DesiredCount");

    if (legacyDomainName !== domainName) {
      new route53.ARecord(this, "CanonicalDomainAliasRecord", {
        zone: hostedZone,
        recordName: domainName,
        target: route53.RecordTarget.fromAlias(
          new route53Targets.LoadBalancerTarget(webService.loadBalancer),
        ),
      });
    }

    const chatWorkerService = createWorkerService(this, {
      cluster,
      repository,
      tag: `worker-${imageTag.valueAsString}`,
      family: "ai-workspace-chat-worker",
      serviceName: "ai-workspace-chat-worker",
      containerName: "chat-worker",
      logGroup: chatWorkerLogGroup,
      securityGroup: workerSecurityGroup,
      environment: {
        ...commonEnvironment,
        // T311b/T312 (specs/003): worker-executed lanes — durable chat,
        // skills, scheduled — run on Bedrock AgentCore in our account.
        // Fast chat stays direct Bedrock on web.
        RUNTIME: "agentcore",
        AGENTCORE_RUNTIME_ARN:
          "arn:aws:bedrock-agentcore:us-east-1:351478076796:runtime/ai_workspace_agent_spike-5n8RLRBVz5",
        MEMORY_CAPTURE_IN_PROCESS_SCHEDULER: "0",
      },
      secrets: commonSecrets,
      grantBedrock: true,
    });

    const memoryWorkerService = createWorkerService(this, {
      cluster,
      repository,
      tag: `memory-worker-${imageTag.valueAsString}`,
      family: "ai-workspace-memory-worker",
      serviceName: "ai-workspace-memory-worker",
      containerName: "memory-worker",
      logGroup: memoryWorkerLogGroup,
      securityGroup: workerSecurityGroup,
      environment: {
        ...commonEnvironment,
        MEMORY_CAPTURE_IN_PROCESS_SCHEDULER: "0",
      },
      secrets: commonSecrets,
      grantBedrock: true,
    });

    const memoryCaptureFailureMetric = new logs.MetricFilter(
      this,
      "MemoryCaptureFailureMetric",
      {
        logGroup: memoryWorkerLogGroup,
        filterPattern: logs.FilterPattern.anyTerm(
          "memory-capture-error",
          "memory-capture-worker-fatal",
        ),
        metricNamespace: "Comparative/Workers",
        metricName: "MemoryCaptureFailures",
        metricValue: "1",
        defaultValue: 0,
      },
    );
    const memoryCaptureFailureAlarm = new cloudwatch.Alarm(
      this,
      "MemoryCaptureFailureAlarm",
      {
        alarmName: "ai-workspace-memory-capture-failures",
        alarmDescription:
          "The memory worker logged a capture failure in the last 20 minutes.",
        metric: memoryCaptureFailureMetric.metric({
          statistic: "Sum",
          period: cdk.Duration.minutes(20),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    );
    // #509 class: an alarm with no action is an alarm nobody receives.
    memoryCaptureFailureAlarm.addAlarmAction(opsAlertAction);

    // #706: CI evals and production currently share this account/model quota.
    // CloudFormation does not yet expose CloudWatch's wall-clock evaluation
    // window, so this deliberately uses a conservative rolling 24-hour sum.
    // It can warn briefly after the UTC quota reset, but it cannot miss an
    // approaching exhaustion because of a calendar boundary.
    const bedrockTokenMetric = (metricName: string) =>
      new cloudwatch.Metric({
        namespace: "AWS/Bedrock",
        metricName,
        dimensionsMap: { ModelId: BEDROCK_SONNET_45_MODEL_ID },
        statistic: "Sum",
        period: cdk.Duration.days(1),
      });
    const bedrockTokenMetrics = {
      inputTokens: bedrockTokenMetric("InputTokenCount"),
      outputTokens: bedrockTokenMetric("OutputTokenCount"),
      cacheWriteTokens: bedrockTokenMetric("CacheWriteInputTokenCount"),
    };
    const bedrockDailyTokenHeadroomAlarm = new cloudwatch.Alarm(
      this,
      "BedrockDailyTokenHeadroomAlarm",
      {
        alarmName: "ai-workspace-bedrock-sonnet-4-5-token-headroom",
        alarmDescription:
          "#706: rolling 24-hour Sonnet 4.5 token consumption reached 80% of the 5.4M account quota; CI can now starve production.",
        metric: new cloudwatch.MathExpression({
          expression:
            "FILL(inputTokens, 0) + FILL(outputTokens, 0) + FILL(cacheWriteTokens, 0)",
          usingMetrics: bedrockTokenMetrics,
          period: cdk.Duration.days(1),
        }),
        threshold: BEDROCK_DAILY_TOKEN_WARNING_THRESHOLD,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    );
    bedrockDailyTokenHeadroomAlarm.addAlarmAction(opsAlertAction);
    bedrockDailyTokenHeadroomAlarm.addOkAction(opsAlertAction);

    if (codeBuildRoleArn) {
      const codeBuildRole = iam.Role.fromRoleArn(
        this,
        "CodeBuildAiWorkspaceRole",
        codeBuildRoleArn,
        { mutable: true },
      );
      codeBuildRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ["ecs:DescribeServices", "ecs:UpdateService"],
          resources: [
            webService.service.serviceArn,
            chatWorkerService.serviceArn,
            memoryWorkerService.serviceArn,
          ],
        }),
      );
      codeBuildRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ["sts:AssumeRole"],
          resources: [
            `arn:${this.partition}:iam::${this.account}:role/cdk-hnb659fds-deploy-role-${this.account}-${this.region}`,
            `arn:${this.partition}:iam::${this.account}:role/cdk-hnb659fds-file-publishing-role-${this.account}-${this.region}`,
          ],
        }),
      );
    }

    // This stack is the single owner of `ai-workspace-web-unhealthy-hosts`.
    // setup-ops-alarms.sh used to write the same alarm name with different
    // settings, so whichever ran last silently won; the script no longer
    // touches it. Statistic/datapoints match what the script used, so the
    // handover does not weaken the alarm.
    const webUnhealthyHostsAlarm = new cloudwatch.Alarm(
      this,
      "WebUnhealthyHostsAlarm",
      {
        alarmName: "ai-workspace-web-unhealthy-hosts",
        alarmDescription:
          "The web target group has had unhealthy hosts for 3 minutes.",
        metric: webService.targetGroup.metrics.unhealthyHostCount({
          statistic: "Maximum",
          period: cdk.Duration.minutes(1),
        }),
        threshold: 1,
        evaluationPeriods: 3,
        datapointsToAlarm: 3,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    );
    webUnhealthyHostsAlarm.addAlarmAction(opsAlertAction);
    webUnhealthyHostsAlarm.addOkAction(opsAlertAction);

    // #568: unhealthy hosts detect bad registered targets; this detects the
    // service falling below its declared availability floor. `LiveTaskCount`
    // is the standard AWS/ECS metric — `RunningTaskCount` lives in the paid
    // Container Insights namespace, which this cluster deliberately disables.
    // Missing data breaches: a dead metric is exactly the outage this alarm
    // exists to catch, so it must page rather than silently pass.
    const webTaskFloorAlarm = new cloudwatch.Alarm(this, "WebTaskFloorAlarm", {
      alarmName: "ai-workspace-web-below-task-floor",
      alarmDescription: `#568: the web service has had fewer than ${WEB_MIN_TASK_COUNT} live ECS tasks for 3 minutes.`,
      metric: new cloudwatch.Metric({
        namespace: "AWS/ECS",
        metricName: "LiveTaskCount",
        dimensionsMap: {
          ClusterName: CLUSTER_NAME,
          ServiceName: WEB_SERVICE_NAME,
        },
        statistic: "Minimum",
        period: cdk.Duration.minutes(1),
      }),
      threshold: WEB_MIN_TASK_COUNT,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    webTaskFloorAlarm.addAlarmAction(opsAlertAction);
    webTaskFloorAlarm.addOkAction(opsAlertAction);

    new cdk.CfnOutput(this, "Url", {
      value: `https://${domainName}`,
    });
    if (legacyDomainName !== domainName) {
      new cdk.CfnOutput(this, "LegacyUrl", {
        value: `https://${legacyDomainName}`,
      });
    }
    new cdk.CfnOutput(this, "ClusterName", {
      value: cluster.clusterName,
    });
    new cdk.CfnOutput(this, "WebServiceName", {
      value: webService.service.serviceName,
    });
    new cdk.CfnOutput(this, "ChatWorkerServiceName", {
      value: chatWorkerService.serviceName,
    });
    new cdk.CfnOutput(this, "MemoryWorkerServiceName", {
      value: memoryWorkerService.serviceName,
    });
    new cdk.CfnOutput(this, "AppSecretName", {
      value: appSecretName,
    });
  }
}

function createWorkerService(
  scope: Construct,
  input: {
    cluster: ecs.Cluster;
    repository: ecr.IRepository;
    tag: string;
    family: string;
    serviceName: string;
    containerName: string;
    logGroup: logs.ILogGroup;
    securityGroup: ec2.ISecurityGroup;
    environment: Record<string, string>;
    secrets: Record<string, ecs.Secret>;
    grantBedrock: boolean;
  },
): ecs.FargateService {
  const task = new ecs.FargateTaskDefinition(scope, `${input.family}Task`, {
    family: input.family,
    cpu: WORKER_TASK_SIZE.cpu,
    memoryLimitMiB: WORKER_TASK_SIZE.memoryLimitMiB,
  });
  if (input.grantBedrock) grantBedrockInvoke(task);
  task.addContainer(input.containerName, {
    image: ecs.ContainerImage.fromEcrRepository(input.repository, input.tag),
    containerName: input.containerName,
    logging: ecs.LogDrivers.awsLogs({
      streamPrefix: input.containerName,
      logGroup: input.logGroup,
    }),
    environment: input.environment,
    secrets: input.secrets,
  });
  return new ecs.FargateService(scope, `${input.family}Service`, {
    cluster: input.cluster,
    serviceName: input.serviceName,
    taskDefinition: task,
    desiredCount: 1,
    assignPublicIp: true,
    securityGroups: [input.securityGroup],
    vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    minHealthyPercent: 0,
    maxHealthyPercent: 200,
    circuitBreaker: { rollback: true },
  });
}

function grantBedrockInvoke(task: ecs.FargateTaskDefinition): void {
  task.addToTaskRolePolicy(
    new iam.PolicyStatement({
      actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      resources: ["*"],
    }),
  );
}

function grantSesSendEmail(
  task: ecs.FargateTaskDefinition,
  identityName: string,
  region: string,
): void {
  const stack = cdk.Stack.of(task);
  task.addToTaskRolePolicy(
    new iam.PolicyStatement({
      actions: ["ses:SendEmail"],
      resources: [
        `arn:${stack.partition}:ses:${region}:${stack.account}:identity/${identityName}`,
      ],
    }),
  );
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
