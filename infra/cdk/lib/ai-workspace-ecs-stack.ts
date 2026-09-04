import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
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
const BROWSER_PROXY_SERVICE_NAME = "ai-workspace-browser-proxy";
const BROWSER_PROXY_PORT = 3128;
// AgentCore Browser currently supports physical AZs use1-az1, use1-az2, and
// use1-az4 in us-east-1. In Comparative's production account those map to the
// following names. Passing all six default-VPC subnets makes BrowserCustom
// fail creation, so keep its subnet selection narrower than the ECS services.
const STUDIO_BROWSER_AVAILABILITY_ZONES = [
  "us-east-1a",
  "us-east-1b",
  "us-east-1c",
];
const BEDROCK_SONNET_45_MODEL_ID =
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const BEDROCK_SONNET_45_DAILY_TOKEN_QUOTA = 5_400_000;
const BEDROCK_SONNET_45_OUTPUT_TOKEN_BURNDOWN_RATE = 5;
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
    const browserProxyImageTag = new cdk.CfnParameter(
      this,
      "BrowserProxyImageTag",
      {
        type: "String",
        default: "worker-latest",
        description:
          "Exact worker image tag for the Browser proxy. Rollbacks preserve the currently deployed proxy so pre-Browser app images remain valid rollback targets.",
      },
    );

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
    const browserProxyDbSecretName = contextString(
      this,
      "aiWorkspace:browserProxyDbSecretName",
      "ai-workspace/production/browser-proxy-db",
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
    // Provisioned out of band (#849): a DATABASE_URL for the NOLOGIN-by-default
    // `web_egress_policy_reader` role from migration 0049, which can SELECT
    // only the egress-policy columns of tools_catalog. The browser proxy is
    // the sole consumer; it must never receive the app secret.
    const browserProxyDbSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "BrowserProxyDbSecret",
      browserProxyDbSecretName,
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
    cluster.addDefaultCloudMapNamespace({
      name: "comparative.internal",
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
    const browserProxySecurityGroup = new ec2.SecurityGroup(
      this,
      "BrowserProxySecurityGroup",
      {
        vpc,
        description: "Comparative governed AgentCore Browser egress proxy",
        allowAllOutbound: false,
      },
    );
    const browserSecurityGroup = new ec2.SecurityGroup(
      this,
      "StudioBrowserSecurityGroup",
      {
        vpc,
        description: "AgentCore Browser restricted to proxy and VPC DNS",
        allowAllOutbound: false,
      },
    );
    browserProxySecurityGroup.addIngressRule(
      browserSecurityGroup,
      ec2.Port.tcp(BROWSER_PROXY_PORT),
      "AgentCore Browser reaches only the governed proxy",
    );
    browserSecurityGroup.addEgressRule(
      browserProxySecurityGroup,
      ec2.Port.tcp(BROWSER_PROXY_PORT),
      "Browser egress through Comparative proxy",
    );
    browserSecurityGroup.addEgressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.udp(53),
      "VPC DNS resolution",
    );
    browserSecurityGroup.addEgressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(53),
      "VPC DNS resolution over TCP",
    );
    browserProxySecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      "Public HTTP targets",
    );
    browserProxySecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "Public HTTPS and AWS APIs",
    );
    browserProxySecurityGroup.addEgressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.udp(53),
      "VPC DNS resolution",
    );
    browserProxySecurityGroup.addEgressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(53),
      "VPC DNS resolution over TCP",
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
    databaseSecurityGroup.addIngressRule(
      browserProxySecurityGroup,
      ec2.Port.tcp(5432),
      "Comparative Browser proxy reads governed egress policy",
    );
    browserProxySecurityGroup.addEgressRule(
      databaseSecurityGroup,
      ec2.Port.tcp(5432),
      "Read governed egress policy from Postgres",
    );
    const browserProxySecret = new secretsmanager.Secret(
      this,
      "BrowserProxySecret",
      {
        secretName: "ai-workspace/production/browser-proxy",
        description:
          "Basic auth used only between AgentCore Browser and the governed egress proxy",
        generateSecretString: {
          secretStringTemplate: JSON.stringify({
            username: "comparative-browser",
          }),
          generateStringKey: "password",
          passwordLength: 48,
          excludePunctuation: true,
        },
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
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
    const browserProxyLogGroup = new logs.LogGroup(
      this,
      "BrowserProxyLogGroup",
      {
        logGroupName: "/ecs/ai-workspace/browser-proxy",
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      },
    );

    const browserProxyTask = new ecs.FargateTaskDefinition(
      this,
      "BrowserProxyTask",
      {
        family: "ai-workspace-browser-proxy",
        cpu: WORKER_TASK_SIZE.cpu,
        memoryLimitMiB: WORKER_TASK_SIZE.memoryLimitMiB,
      },
    );
    browserProxyTask.addContainer("browser-proxy", {
      image: ecs.ContainerImage.fromEcrRepository(
        repository,
        browserProxyImageTag.valueAsString,
      ),
      containerName: "browser-proxy",
      command: [
        "pnpm",
        "--filter",
        "@ai-workspace/web",
        "browser:egress-proxy",
      ],
      portMappings: [{ containerPort: BROWSER_PROXY_PORT }],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "browser-proxy",
        logGroup: browserProxyLogGroup,
      }),
      healthCheck: {
        command: [
          "CMD-SHELL",
          `node -e "const s=require('net').connect(${BROWSER_PROXY_PORT},'127.0.0.1');s.setTimeout(2000);s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));s.on('timeout',()=>process.exit(1))"`,
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(15),
      },
      environment: {
        NODE_ENV: "production",
        AWS_REGION: cdk.Stack.of(this).region,
        BROWSER_PROXY_PORT: String(BROWSER_PROXY_PORT),
      },
      secrets: {
        // Read-only role scoped to the egress policy row; never the app secret.
        DATABASE_URL: ecs.Secret.fromSecretsManager(
          browserProxyDbSecret,
          "DATABASE_URL",
        ),
        BROWSER_PROXY_USERNAME: ecs.Secret.fromSecretsManager(
          browserProxySecret,
          "username",
        ),
        BROWSER_PROXY_PASSWORD: ecs.Secret.fromSecretsManager(
          browserProxySecret,
          "password",
        ),
      },
    });
    const browserProxyService = new ecs.FargateService(
      this,
      "BrowserProxyService",
      {
        cluster,
        serviceName: BROWSER_PROXY_SERVICE_NAME,
        taskDefinition: browserProxyTask,
        desiredCount: 1,
        assignPublicIp: true,
        securityGroups: [browserProxySecurityGroup],
        vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        cloudMapOptions: { name: "browser-proxy" },
        minHealthyPercent: 100,
        maxHealthyPercent: 200,
        circuitBreaker: { rollback: true },
      },
    );

    const studioBrowser = new agentcore.BrowserCustom(
      this,
      "StudioBrowser",
      {
        browserCustomName: "comparative_studio_browser",
        description: "Isolated browser for Comparative Contribution Studio",
        networkConfiguration: agentcore.BrowserNetworkConfiguration.usingVpc(
          this,
          {
            vpc,
            vpcSubnets: {
              subnetType: ec2.SubnetType.PUBLIC,
              availabilityZones: STUDIO_BROWSER_AVAILABILITY_ZONES,
            },
            securityGroups: [browserSecurityGroup],
          },
        ),
        browserSigning: agentcore.BrowserSigning.ENABLED,
      },
    );
    browserProxySecret.grantRead(studioBrowser.executionRole);

    const webTask = new ecs.FargateTaskDefinition(this, "WebTask", {
      family: "ai-workspace-web",
      cpu: 512,
      memoryLimitMiB: 1024,
    });
    // StartBrowserSession validates that its caller may read credentials for
    // every configured proxy, even though the Browser execution role also
    // needs access when the managed session starts.
    browserProxySecret.grantRead(webTask.taskRole);
    grantBedrockInvoke(webTask);
    grantSesSendEmail(webTask, inviteEmailIdentityName, inviteEmailAwsRegion);
    studioBrowser.grant(
      webTask.taskRole,
      "bedrock-agentcore:StartBrowserSession",
      "bedrock-agentcore:GetBrowserSession",
      "bedrock-agentcore:StopBrowserSession",
      "bedrock-agentcore:InvokeBrowser",
      "bedrock-agentcore:ConnectBrowserLiveViewStream",
    );
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
        AGENTCORE_BROWSER_ENABLED: "1",
        AGENTCORE_BROWSER_ID: studioBrowser.browserId,
        AGENTCORE_BROWSER_PROXY_HOST:
          "browser-proxy.comparative.internal",
        AGENTCORE_BROWSER_PROXY_PORT: String(BROWSER_PROXY_PORT),
        AGENTCORE_BROWSER_PROXY_SECRET_ARN: browserProxySecret.secretArn,
        STUDIO_SANDBOX_DNS_SUFFIX: ".comparative.internal",
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

    const browserProxyTaskAlarm = new cloudwatch.Alarm(
      this,
      "BrowserProxyTaskAlarm",
      {
        alarmName: "ai-workspace-browser-proxy-unavailable",
        alarmDescription:
          "The governed AgentCore Browser egress proxy has no live ECS task.",
        metric: new cloudwatch.Metric({
          namespace: "AWS/ECS",
          metricName: "LiveTaskCount",
          dimensionsMap: {
            ClusterName: CLUSTER_NAME,
            ServiceName: BROWSER_PROXY_SERVICE_NAME,
          },
          statistic: "Minimum",
          period: cdk.Duration.minutes(1),
        }),
        threshold: 1,
        evaluationPeriods: 3,
        datapointsToAlarm: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      },
    );
    browserProxyTaskAlarm.addAlarmAction(opsAlertAction);
    browserProxyTaskAlarm.addOkAction(opsAlertAction);

    // #706: CI evals and production currently share this account/model quota.
    // EvaluationWindow is intentionally absent: CloudWatch defaults to a
    // sliding window, so this is a rolling 24-hour sum evaluated every minute.
    // It can warn briefly after the UTC quota reset, but it cannot miss an
    // approaching exhaustion because of a calendar boundary.
    // AWS excludes cache reads from quota and applies a 5x quota burndown to
    // Sonnet 4.5 output tokens. Keep this expression aligned with the Bedrock
    // token-burndown contract, not billing totals.
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
      // AWS documents CacheWriteInputTokens, while this account currently
      // publishes CacheWriteInputTokenCount. MAX keeps the alarm correct
      // during that service-side naming transition without double-counting.
      cacheWriteTokens: bedrockTokenMetric("CacheWriteInputTokens"),
      cacheWriteTokenCount: bedrockTokenMetric(
        "CacheWriteInputTokenCount",
      ),
    };
    const bedrockDailyTokenHeadroomAlarm = new cloudwatch.Alarm(
      this,
      "BedrockDailyTokenHeadroomAlarm",
      {
        alarmName: "ai-workspace-bedrock-sonnet-4-5-token-headroom",
        alarmDescription:
          "#706: rolling 24-hour Sonnet 4.5 token consumption reached 80% of the 5.4M account quota; CI can now starve production.",
        metric: new cloudwatch.MathExpression({
          expression: `FILL(inputTokens, 0) + MAX([FILL(cacheWriteTokens, 0), FILL(cacheWriteTokenCount, 0)]) + (FILL(outputTokens, 0) * ${BEDROCK_SONNET_45_OUTPUT_TOKEN_BURNDOWN_RATE})`,
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
            browserProxyService.serviceArn,
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
    new cdk.CfnOutput(this, "BrowserProxyServiceName", {
      value: browserProxyService.serviceName,
    });
    new cdk.CfnOutput(this, "StudioBrowserId", {
      value: studioBrowser.browserId,
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
