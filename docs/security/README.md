# Security Review Packet

This directory is the entry point for a Comparative security review. It
describes the system that is deployed today, not a future enterprise target.
Planned controls are labeled as gaps and linked to their backlog issue.

Last verified against source and the `us-east-1` pilot deployment:
2026-07-23.

## Review artifacts

- [Threat model](./THREAT_MODEL.md): assets, trust boundaries, abuse cases,
  existing controls, and residual risk.
- [Incident response](./INCIDENT_RESPONSE.md): severity, evidence, containment,
  recovery, and post-incident steps.
- [Data flow and classification](./DATA_FLOW_AND_CLASSIFICATION.md): data
  classes, stores, encryption, retention, and egress inventory.
- [Audit surfaces](../AUDIT_SURFACES.md): action-level source of truth for the
  append-only application audit ledger.
- [Production deployment](../PRODUCTION_DEPLOYMENT.md): deploy verification
  and rollback procedure.

These documents are engineering evidence, not a compliance certification or a
legal DPA. Security, privacy, and legal owners must approve retention,
residency, breach-notification, and regulated-data requirements before an
enterprise rollout.

## Current posture summary

| Area | Verified pilot state | Gap / decision |
|---|---|---|
| Runtime | Three ECS/Fargate services behind an HTTPS ALB; direct Bedrock for fast turns and AgentCore for worker turns | Tasks run in public subnets with public IPs and unrestricted outbound security-group egress; private networking is tracked by [#492](https://github.com/DadJokez/AI-workspace/issues/492) |
| Database | RDS PostgreSQL; application connection requires TLS (`sslmode=require`) | Storage encryption is disabled, the instance is publicly addressable, single-AZ, has one day of automated backups, and has no deletion protection; remediation belongs to [#492](https://github.com/DadJokez/AI-workspace/issues/492) |
| Secrets | Runtime secrets are injected from AWS Secrets Manager; OAuth access and refresh tokens are additionally encrypted with AES-256-GCM before Postgres persistence | The app secret uses the AWS-managed Secrets Manager key and has no automatic rotation; rotation and key-separation work require an approved plan |
| Identity | Invite-gated email magic links and optional GitHub OAuth, both using NextAuth JWT sessions | Enterprise OIDC/SCIM and deprovisioning are not live |
| Authorization | Owner-scoped queries, app/skill share checks, tool attestations, signed write context for supported providers, and audited cross-owner admin reads | Admin is a coarse role; database-level append-only audit enforcement is pending [#457](https://github.com/DadJokez/AI-workspace/issues/457), and tri-state tool policy is pending [#410](https://github.com/DadJokez/AI-workspace/issues/410) |
| Model data | Bedrock and AgentCore execute in the Comparative AWS account | Model IDs use `us.*` cross-region inference profiles; formal residency acceptance or single-region routing is pending [#492](https://github.com/DadJokez/AI-workspace/issues/492) |
| Logs and alerts | ECS logs retain 30 days. SNS email receives worker-liveness, ALB/target 5xx, unhealthy-host, and run-failure alarms | The CDK memory-capture failure alarm has no notification action; SIEM export and broader alert coverage are pending [#492](https://github.com/DadJokez/AI-workspace/issues/492) |
| Retention | Product rows persist until user/admin lifecycle actions; CloudWatch log groups retain 30 days | Approved retention values, hard deletion, legal hold, and deprovisioning are pending [#460](https://github.com/DadJokez/AI-workspace/issues/460) |

## Evidence and maintenance

The following source files are the primary implementation evidence:

- [`infra/cdk/lib/ai-workspace-ecs-stack.ts`](../../infra/cdk/lib/ai-workspace-ecs-stack.ts)
- [`infra/scripts/setup-ops-alarms.sh`](../../infra/scripts/setup-ops-alarms.sh)
- [`packages/db/src/schema.ts`](../../packages/db/src/schema.ts)
- [`apps/web/lib/auth/nextauth.ts`](../../apps/web/lib/auth/nextauth.ts)
- [`apps/web/lib/auth/scope.ts`](../../apps/web/lib/auth/scope.ts)
- [`apps/web/lib/oauth/crypto.ts`](../../apps/web/lib/oauth/crypto.ts)
- [`apps/web/lib/tool-redaction.ts`](../../apps/web/lib/tool-redaction.ts)
- [`packages/agent/src/web-fetch-tool.ts`](../../packages/agent/src/web-fetch-tool.ts)
- [`packages/agent/src/models.ts`](../../packages/agent/src/models.ts)

Update this packet in the same PR when a trust boundary, data store, identity
provider, execution lane, external processor, retention rule, or production
network boundary changes. Re-verify the live-state table before each formal
security review.
