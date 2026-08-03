# Security Review Packet

This directory is the entry point for a Comparative security review. It
describes the system that is deployed today, not a future enterprise target.
Planned controls are labeled as gaps and linked to their backlog issue.

Last verified against source and the `us-east-1` pilot deployment:
2026-08-03 (AWS API, GitHub API, VPC migration, and authenticated production
smoke re-checked).

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
- [Runbooks](../runbooks/README.md): database restore-from-snapshot rehearsal,
  AgentCore rollback, and the manual DSAR / right-to-delete procedure.

These documents are engineering evidence, not a compliance certification or a
legal DPA. Security, privacy, and legal owners must approve retention,
residency, breach-notification, and regulated-data requirements before an
enterprise rollout.

## Current posture summary

| Area | Verified pilot state | Gap / decision |
|---|---|---|
| Runtime | Three ECS/Fargate services behind an HTTPS ALB; direct Bedrock for fast turns and AgentCore for worker turns | Tasks run in public subnets with public IPs and unrestricted outbound security-group egress; private networking is tracked by [#492](https://github.com/DadJokez/AI-workspace/issues/492) |
| Database | RDS PostgreSQL; application connection requires TLS (`sslmode=require`); instance is non-public and 5432 is limited to the web, worker, and deploy-task security groups | Storage encryption is disabled ([#689](https://github.com/DadJokez/AI-workspace/issues/689)); RDS predates the stack, so a fail-closed [perimeter reconciler](../runbooks/RDS_NETWORK_PERIMETER.md) enforces the boundary until full adoption in [#492](https://github.com/DadJokez/AI-workspace/issues/492); single-AZ, one day of automated backups, no deletion protection, no restore drill (procedure: [DB restore rehearsal](../runbooks/DB_RESTORE_REHEARSAL.md)) |
| Secrets | Runtime secrets are injected from AWS Secrets Manager; OAuth access and refresh tokens are additionally encrypted with AES-256-GCM before Postgres persistence | The app secret uses the AWS-managed Secrets Manager key and has no automatic rotation; rotation and key-separation work require an approved plan |
| Identity | Invite-gated email magic links and optional GitHub OAuth, both using NextAuth JWT sessions | Enterprise OIDC/SCIM and deprovisioning are not live; no authentication event reaches the audit ledger ([#694](https://github.com/DadJokez/AI-workspace/issues/694)); `allowDangerousEmailAccountLinking` is set on the GitHub provider — the reasoning and what would invalidate it are recorded in the [threat model](./THREAT_MODEL.md#authentication-and-identity-decisions) |
| Connected providers | Per-user OAuth to GitHub, Google, Notion, and Salesforce; tokens AES-256-GCM encrypted; connect is audited | **There is no disconnect route** — a user cannot withdraw a provider connection from inside Comparative and the token row survives provider-side revocation ([#692](https://github.com/DadJokez/AI-workspace/issues/692)) |
| Web perimeter | Internet-facing ALB, HTTPS with HTTP redirect, access logging to an SSE-S3 bucket | No WAF ([#691](https://github.com/DadJokez/AI-workspace/issues/691)); the application sends no security response headers — no CSP, HSTS, `nosniff`, or `frame-ancestors` outside the deployed-app sandbox routes ([#693](https://github.com/DadJokez/AI-workspace/issues/693)) |
| Environments | Production only | No staging environment; merging to `main` deploys, and migrations run against production before the new code is live ([#697](https://github.com/DadJokez/AI-workspace/issues/697)). The published load-test model has never been executed ([#696](https://github.com/DadJokez/AI-workspace/issues/696)) |
| Change gate | `main` requires eight status checks, is `strict`, and enforces on admins; a post-merge audit workflow re-verifies every merge | The required `Claude verdict` status is forgeable by any holder of repo `statuses: write`, and workflow actions are pinned to mutable tags ([#698](https://github.com/DadJokez/AI-workspace/issues/698)). The repository is public as of 2026-07-25 — see [threat model T16-T18](./THREAT_MODEL.md#ci-and-supply-chain-threats) |
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
