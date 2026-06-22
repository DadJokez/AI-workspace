# 04 — Open Questions & Decision Log

> Everything Rob (and InfoSec / leadership) must answer before/while committing. Grouped by when the
> answer is needed. Owners and the doc each question feeds are noted.

## Blocking (answer before Phase A)

| # | Question | Why it blocks | Owner | Feeds |
|---|---|---|---|---|
| B1 | **Is AgentCore GA in our approved region (`us-east-1`)?** Docs say "all regions where AgentCore is GA" but don't enumerate. | Can't deploy a harness otherwise; residency. | Rob/AWS | [02](02-target-architecture.md), [security](specs/security-and-compliance.md) |
| B2 | **Bedrock-native vs Claude-Platform-on-AWS** as the model channel. | Sets billing, IAM, model-ARN scoping, day-0 feature access. | Rob | [05-adr/002](05-adr/002-bedrock-vs-claude-platform.md) |
| B3 | **Does InfoSec need to review the microVM isolation model before any GP data?** | If yes, it's a hard predecessor to Phase B/C. | InfoSec | [security](specs/security-and-compliance.md) |
| B4 | **Separate AWS account for AgentCore workloads, or stay in `<AWS_ACCOUNT_ID>`?** | Drives cross-account trust, KMS, network design now. | Rob/InfoSec | [iam](specs/iam-and-execution-roles.md) |
| B5 | **Can we move ECS + AgentCore egress off the default-VPC PUBLIC subnets to private + NAT/PrivateLink without breaking the imported RDS SG (`sg-019e87b5938a295a4`)?** | The standing landmine; pilot blocker. | Rob | [01 §10](01-current-state.md), [iam](specs/iam-and-execution-roles.md) |
| B6 | **Do Bedrock `us.` cross-region inference profiles stay within GP's residency boundary?** If not, switch to single-region profiles. | Residency; analogous to the prior Cursor-residency issue. | InfoSec | [security](specs/security-and-compliance.md), [models.ts](../../packages/agent/src/models.ts) |

## Soon (answer by Phase C)

| # | Question | Why | Owner | Feeds |
|---|---|---|---|---|
| S1 | **PingOne vs PingFederate** specifically, and the OIDC app config / claim mapping for `users.ping_subject`. | Parallel SSO track lands in Phase C. | Rob/IT | [02 §3](02-target-architecture.md) |
| S2 | **One skill-runner harness + per-invocation overrides, or one harness per saved skill?** | Shapes versioning, IAM, the publish pipeline. (Recommendation: skill-runner + overrides.) | Rob | [skills](specs/skills-bundle-structure.md) |
| S3 | **Managed AgentCore Memory vs RDS-only** for turn continuity — accept a second conversation-data store for IT review? | Cost + audit surface. (Recommendation: managed for accelerate, RDS stays SoR.) | Rob/InfoSec | [02 §6](02-target-architecture.md), [cost](specs/cost-model.md) |
| S4 | **Notion same-origin relay:** re-host as Gateway HTTP passthrough, or keep Notion on a shell path? | Phase B parity blocker. | Rob | [gateway](specs/gateway-targets.md) |
| S5 | **A/B promotion thresholds** (p-value, min N, MDE per metric) — accept p<0.05 / N≥200 default? | Promotion gate. | Rob | [eval](specs/eval-and-optimization-loop.md) |
| S6 | **Real workload numbers** (DAU, turns/user/day, token sizes, model mix) — instrument now. | Turns the cost model from estimate to fact. | Rob | [cost](specs/cost-model.md) |
| S7 | **RDS instance class / Multi-AZ / storage** (not in CDK). | Missing line item in the cost model. | Rob | [cost](specs/cost-model.md) |

## Eventually

| # | Question | Owner | Feeds |
|---|---|---|---|
| E1 | **Wait for first-party `agentcore_web_search`, or Gateway-target workaround now?** (Recommendation: workaround now, swap on GA.) | Rob | [gateway](specs/gateway-targets.md) |
| E2 | **Build vs buy the skills contribution/publish pipeline** (how business users edit skills safely). (Recommendation: build on the existing `/skills` UI + render-to-S3.) | Rob | [skills](specs/skills-bundle-structure.md) |
| E3 | **SAP ERP RFC owner + timing** (Tier 3; auth is module-specific). | Rob/IT | [gateway](specs/gateway-targets.md), [ROADMAP.md:500](../ROADMAP.md) |
| E4 | **Add Bedrock Guardrails** (denied topics, classifier PII) now that model invocation is centralized? | Rob/InfoSec | [security](specs/security-and-compliance.md) |
| E5 | **Which workloads graduate to Strands-on-Runtime** (app-build J4, agent-authored notebooks) and when. | Rob | [05-adr/005](05-adr/005-harness-vs-runtime-graduation.md) |
| E6 | **Retire the runtime-v2 preview cluster** once endpoints replace it (cost + ops). | Rob | [03 Phase F](03-roadmap.md) |
| E7 | **Claude Agent SDK export** (vs Strands) once GA — preferred graduation target? | Rob | [05-adr/005](05-adr/005-harness-vs-runtime-graduation.md) |

## Decision log

| Date | Decision | Status |
|---|---|---|
| 2026-06-19 | Engagement framing = three-way convergence onto managed Harness | **Confirmed (Rob)** |
| 2026-06-19 | Spec integration set = shipped connectors + roadmap wedges | **Confirmed (Rob)** |
| 2026-06-19 | Enterprise IdP = PingOne / PingFederate OIDC | **Confirmed (Rob)** |
| — | Bedrock-native vs Claude-Platform | **Open (B2 / ADR-002)** |
| — | Dedicated AgentCore account | **Open (B4)** |
