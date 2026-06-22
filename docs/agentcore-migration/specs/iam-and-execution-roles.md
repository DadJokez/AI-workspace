# Spec — IAM, Execution Roles, Trust Policies, KMS

> Least-privilege per harness. Placeholders for ARNs/KMS keys until the IaC pass. **This is a
> human-owned area (per [CLAUDE.md] review rubric): every role/policy here needs Rob + InfoSec sign-off.**

## Assumptions

- Account `<AWS_ACCOUNT_ID>`, region `us-east-1` (today). A dedicated AgentCore account is an open
  question ([04-open-questions.md](../04-open-questions.md)).
- One **execution role per harness** (not per user); user-level scoping is `actorId` + `allowedTools`
  + Gateway target scopes. Inbound caller = the Fargate shell task role via SigV4.
- The current AgentCore spike role is **deliberately over-broad** — `bedrock:InvokeModel` on `*` and
  NetworkMode PUBLIC ([ai-workspace-agentcore-spike-stack.ts:48](../../../infra/cdk/lib/ai-workspace-agentcore-spike-stack.ts),
  flagged "tighten before pilot" in [specs/003/plan.md](../../../specs/003-agentcore-substrate/plan.md)).
  This spec defines the tightened target.

## Role inventory

| Role | Principal / trust | Purpose |
|---|---|---|
| `ComparativeShellTaskRole` | ECS task (`apps/web`) | calls `bedrock-agentcore:InvokeHarness`; reads Secrets Manager; RDS |
| `HarnessExecRole-chat` | `bedrock-agentcore.amazonaws.com` | exec role for the chat/Q&A harness |
| `HarnessExecRole-analytics` | `bedrock-agentcore.amazonaws.com` | marketing-analytics harness (adds Code Interpreter, Databricks Gateway) |
| `HarnessExecRole-awsops` | `bedrock-agentcore.amazonaws.com` | AWS-ops harness (awsSkills + scoped AWS read APIs) |
| `GatewayInvokeRole` | Gateway service | brokers outbound auth via Identity vault |

## Trust policy (harness exec role)

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "bedrock-agentcore.amazonaws.com" },
    "Action": "sts:AssumeRole",
    "Condition": {
      "StringEquals": { "aws:SourceAccount": "<AWS_ACCOUNT_ID>" },
      "ArnLike": { "aws:SourceArn": "arn:aws:bedrock-agentcore:us-east-1:<AWS_ACCOUNT_ID>:harness/*" }
    }
  }]
}
```

## Permissions per harness (least privilege)

### `HarnessExecRole-chat`
```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "BedrockModelsScoped", "Effect": "Allow",
      "Action": ["bedrock:InvokeModel","bedrock:InvokeModelWithResponseStream","bedrock:Converse","bedrock:ConverseStream"],
      "Resource": [
        "arn:aws:bedrock:us-east-1::inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0",
        "arn:aws:bedrock:us-east-1::inference-profile/us.anthropic.claude-sonnet-4-6*",
        "arn:aws:bedrock:us-east-1::inference-profile/us.anthropic.claude-opus-4-7*"
      ] },
    { "Sid": "Memory", "Effect": "Allow",
      "Action": ["bedrock-agentcore:CreateEvent","bedrock-agentcore:RetrieveMemory","bedrock-agentcore:ListEvents"],
      "Resource": "arn:aws:bedrock-agentcore:us-east-1:<AWS_ACCOUNT_ID>:memory/comparative-chat" },
    { "Sid": "GatewayTools", "Effect": "Allow",
      "Action": ["bedrock-agentcore:InvokeTool","bedrock-agentcore:ListTools"],
      "Resource": "arn:aws:bedrock-agentcore:us-east-1:<AWS_ACCOUNT_ID>:gateway/comparative-*" },
    { "Sid": "Logs", "Effect": "Allow",
      "Action": ["logs:CreateLogStream","logs:PutLogEvents"],
      "Resource": "arn:aws:logs:us-east-1:<AWS_ACCOUNT_ID>:log-group:/aws/bedrock-agentcore/*" },
    { "Sid": "SkillsBucketRead", "Effect": "Allow",
      "Action": ["s3:GetObject","s3:ListBucket"],
      "Resource": ["arn:aws:s3:::gp-comparative-skills-prod","arn:aws:s3:::gp-comparative-skills-prod/*"] }
  ]
}
```
**Key tightening vs the spike:** Bedrock actions scoped to the **three Claude inference-profile ARNs**
(not `*`), memory scoped to one resource, Gateway scoped to `comparative-*`.

### `HarnessExecRole-analytics` — adds:
```json
{ "Sid": "CodeInterpreter", "Effect": "Allow",
  "Action": ["bedrock-agentcore:StartCodeInterpreterSession","bedrock-agentcore:InvokeCodeInterpreter"],
  "Resource": "arn:aws:bedrock-agentcore:us-east-1:<AWS_ACCOUNT_ID>:code-interpreter/*" }
```
(Databricks reached via Gateway, so no direct Databricks IAM here.)

### `HarnessExecRole-awsops` — adds scoped, **read-only** AWS APIs (the "data + analytics" pattern):
```json
{ "Sid": "AwsReadOnly", "Effect": "Allow",
  "Action": ["ce:GetCostAndUsage","cloudwatch:GetMetricData","s3:ListAllMyBuckets","athena:StartQueryExecution","athena:GetQueryResults"],
  "Resource": "*",
  "Condition": { "StringEquals": { "aws:RequestedRegion": "us-east-1" } } }
```
> Scope this hard with InfoSec; `awsSkills` makes the agent capable across the AWS surface, so the
> **role** is the real boundary.

## Shell → Harness (inbound)
`ComparativeShellTaskRole` needs only:
```json
{ "Effect": "Allow",
  "Action": ["bedrock-agentcore:InvokeHarness"],
  "Resource": "arn:aws:bedrock-agentcore:us-east-1:<AWS_ACCOUNT_ID>:harness/comparative-*" }
```
plus existing Secrets Manager + RDS access. This is the analog of today's `InvokeAgentRuntime` managed
policy ([ai-workspace-agentcore-spike-stack.ts:115](../../../infra/cdk/lib/ai-workspace-agentcore-spike-stack.ts)).

## KMS

- **`kms/comparative-data`** — encrypts RDS, the skills S3 bucket, and CloudWatch GenAI logs. Grant
  decrypt to the harness exec roles only for the resources they read.
- **Identity token vault** holds connector credentials encrypted by AgentCore Identity; this
  **replaces** `OAUTH_ENCRYPTION_KEY` + the `oauth_tokens` table for migrated connectors
  ([apps/web/lib/oauth/crypto.ts](../../../apps/web/lib/oauth/crypto.ts)). Keep `OAUTH_ENCRYPTION_KEY`
  for any connector still on the shell-side path during migration.
- Key rotation: annual, AWS-managed rotation on the CMK; document in
  [security-and-compliance.md](security-and-compliance.md).

## Network

- **Before any real GP data:** move harness + Gateway egress off PUBLIC into **private subnets +
  NAT/PrivateLink**, closing the current public-subnet landmine
  ([ai-workspace-ecs-stack.ts:212](../../../infra/cdk/lib/ai-workspace-ecs-stack.ts), spike NetworkMode
  PUBLIC at [ai-workspace-agentcore-spike-stack.ts:96](../../../infra/cdk/lib/ai-workspace-agentcore-spike-stack.ts)).
  This is a **stop condition** for the production-cutover phase ([03-roadmap.md](../03-roadmap.md)).

## Human-owned checklist (do not let Claude/Codex wave these through)
- [ ] New IAM roles/policies (this whole doc)
- [ ] KMS key creation + grants
- [ ] Identity token-vault connector registrations (= secret/permission changes)
- [ ] Private-subnet/NAT/PrivateLink network change
- [ ] Any cross-account trust if a dedicated AgentCore account is chosen
