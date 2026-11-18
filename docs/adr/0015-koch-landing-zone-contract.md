# ADR 0015: Koch landing-zone contract

- **Status:** Proposed — seeded with Rob's answers; Koch platform answers pending
- **Date:** 2026-11-17
- **Deciders:** Rob (owner), the Koch platform team (for every row marked pending)
- **Related:** epic #970, #971 (this contract), [`KOCH_FIREWALL_PLAN.md`](../roadmap/KOCH_FIREWALL_PLAN.md), [`KOCH_MIGRATION_SPEC.md`](../roadmap/KOCH_MIGRATION_SPEC.md), [`KOCH_INTAKE_QUESTIONS.md`](../roadmap/KOCH_INTAKE_QUESTIONS.md)

## Context

Comparative runs today in one personal AWS account on a public network. Moving it inside the Koch
firewall depends on facts only Koch can supply: who owns the network, where the outbound proxy is, how
identity and Terraform are run. The migration is being built before those facts are known, so each
assumption needs one place where it is written down, sourced, and tied to the variable it controls.

## Decision

This table is the contract. A row is either an answer from a named source or a default the build uses
until an answer arrives. No row states a fact about Koch without a source. When an answer arrives, the
row is updated in a pull request and the variable's value changes with it.

Variable names are the ones in `KOCH_MIGRATION_SPEC.md` §2 (application) and Part B (Terraform).

### Answered by Rob

| # | Question | Answer | Source | Date | Sets |
|---|---|---|---|---|---|
| 1 | Is the target a Koch-vended AWS account on the corporate network? | Yes, one account per environment | Rob, in chat | 2026-11-12 | `envs/koch-{dev,stage,prod}`; `network.mode = "adopt"` |
| 2 | Is a sponsor or platform contact available? | Maybe | Rob, in chat | 2026-11-12 | None. Phases P1–P5 proceed without Koch |
| 3 | Git host and CI | GitHub Enterprise with GitHub Actions | Rob, in chat | 2026-11-12 | `GITHUB_WEB_URL`, `GITHUB_API_URL`, `GITHUB_MCP_URL`; repository owner and name in `ci-identity`; runner label |
| 4 | Terraform Enterprise or S3 state? | Unknown | Rob, in chat | 2026-11-12 | `backend.hcl`. Default: S3 with native locking |
| 5 | Compute | ECS Fargate | Rob, in chat | 2026-11-12 | `stacks/40-services`. No Kubernetes |
| 6 | Identity | Ping, with magic links kept for a while | Rob, in chat | 2026-11-12 | `AUTH_PROVIDERS`, `OIDC_*`, `MAGIC_LINK_ALLOWED_DOMAINS`, `MAGIC_LINK_SUNSET` |
| 7 | Connectors and egress | Microsoft 365, Salesforce and GitHub Enterprise first. Google, Notion, Brave and PostHog dropped | Rob, in chat | 2026-11-12 | `ENABLED_CONNECTOR_PROVIDERS`, `WEB_SEARCH_PROVIDER=none`, `ANALYTICS_PROVIDER=none` |
| 8 | Cross-region Bedrock inference, and sharing the Koch chat tool's gateway | "No", given to a two-part question, so both parts stay open | Rob, in chat | 2026-11-12 | `BEDROCK_INFERENCE_PROFILE_PREFIX`. Default `us.`; own quota assumed |
| 9 | Tenancy | One Koch-wide instance, Georgia-Pacific first, business units as groups | Rob, in chat | 2026-11-12 | `OIDC_GROUPS_CLAIM`, `OIDC_REQUIRED_GROUP`; group substrate at Tier 3 (#986) |
| 10 | Timeline and operator | Ten users in Q1 2027; Rob plus agents operate until 100 users | Rob, in chat | 2026-11-12 | Tier 1 sizing in `env.tfvars` |
| 11 | The personal account | Stays as the cheap sandbox on the same Terraform | Rob, in chat | 2026-11-12 | `firewall_mode = false`, `egress = "nat"` in `envs/personal-*` |

### Pending from the Koch platform team

Each row names the section of the intake questions that asks it.

| Question | Default until answered | Source | Date | Sets |
|---|---|---|---|---|
| Approved regions (§1) | `us-east-1` | Default; no Koch source yet | — | `aws_region`, `AWS_REGION` |
| IAM permissions boundary (§1) | Our own boundary from `00-foundation` | Default | — | Role path and boundary in `ci-identity` and `ecs-service` |
| VPC and subnet ownership (§2) | Koch supplies them | Default, following answer 1 | — | `vpc_id`, `app_subnet_ids`, `data_subnet_ids` |
| DNS name and certificate (§2) | Koch-issued | Default | — | `domain_name`, `certificate_arn`, `NEXTAUTH_URL`, `INTERNAL_BASE_URL` |
| Allowed interface endpoints (§2) | The list in spec WP-09 | Default | — | `interface_endpoints` |
| Outbound proxy address and TLS inspection (§2) | A proxy exists; no inspection | Default | — | `proxy_url`, `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` |
| Inbound webhooks (§2, §3) | None possible | Default | — | `internal_alb = true`, `GITHUB_EVENT_INGEST_MODE=poll` |
| Corporate ranges for the load balancer (§2) | None until supplied | Default | — | `alb_ingress_cidrs` |
| GitHub Enterprise host and MCP endpoint (§3) | No MCP endpoint | Default | — | `GITHUB_*_URL`; empty `GITHUB_MCP_URL` disables the connector |
| Runners and OIDC to AWS (§3) | Hosted runners with OIDC | Default | — | `runner_label`, `create_oidc_provider` |
| Terraform platform, modules and policy (§4) | S3 state, our modules, `policy/` | Default | — | `backend.hcl`, `policy/` |
| Tagging standard (§4) | The tags in spec §1 | Default | — | `tags` |
| Registry, base images, scanning, signing (§5) | ECR in the account, Trivy, KMS signing | Default | — | `00-foundation` ECR and signing key |
| Ping application, group claim, SCIM (§6) | Claim named `groups`; no SCIM at Tier 1 | Default | — | `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_GROUPS_CLAIM`, `OIDC_ADMIN_GROUP` |
| Session policy (§6) | 24 hours, refreshed hourly (today's values) | Default | — | `SESSION_MAX_AGE_SECONDS`, `SESSION_UPDATE_AGE_SECONDS` |
| Log delivery and retention (§7) | CloudWatch, 30 days | Default | — | `60-observability`, log group retention |
| Customer-managed keys (§8) | Yes, keys we create | Default | — | `kms/*` in `00-foundation` |
| Bedrock model access and Guardrails (§9) | Our own quota; Guardrails not yet configured | Default | — | `bedrock_model_ids` |
| Data classification for the pilot (§10) | Not assumed | — | — | None. Blocks opening to users |
| Reviews and change management (§11) | Not assumed | — | — | None. Blocks opening to users |
| Cost allocation (§12) | Tag-based | Default | — | `tags.cost-center` |

### Email inside the firewall

Email stays on the Amazon SES HTTPS API, reached through the proxy allowlist. SES has a VPC interface
endpoint only for SMTP. Using it would mean adding an SMTP client, which is a new production
dependency, and email exists here only to send magic links and invitations, which are temporary in
the Koch build. No SMTP work is planned unless Koch refuses the allowlist entry. This supersedes the
SMTP item in #973.

## Consequences

- Every default above is a place the build can be wrong. Each one is a variable, so a different answer
  changes configuration and not code.
- Two rows block opening to users and have no default: the data classification allowed for a pilot,
  and the reviews that must pass.
- Answer 8 stays open until someone at Koch answers both halves separately.

## Alternatives

- **Wait for the answers before building.** Rejected: phases P1–P5 need nothing from Koch, and the
  rehearsal environment finds most breaks without them.
- **Record assumptions in the plan only.** Rejected: the plan explains the order of work, and
  assumptions scattered through it cannot be checked against the variables they set.

## Revisit when

- A Koch platform contact answers any pending row.
- Koch mandates EKS, Terraform Enterprise or a central registry, each of which replaces a default with
  a different mechanism.
