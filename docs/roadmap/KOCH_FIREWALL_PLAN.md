# Comparative → inside the Koch firewall: Terraform, GitOps, and the 10 → 10,000 ladder

Plan of record, 2026-11-13 01:22Z. Epic **#970**. Written from `main` @ `04ae5d7`, a full read of `infra/`, the
pipeline, the auth/DB/worker code, and a read-only look at the live account. Nothing here is built yet.

## 0. Decisions and open items

Rob's answers in chat on 2026-11-12:

| # | Question | Answer | Effect |
|---|---|---|---|
| 1 | Target is a Koch-vended AWS account on the corporate network? | Yes | One account per environment; `10-network` runs in adopt mode there. |
| 2 | Sponsor or platform contact available? | Maybe | P1–P5 proceed without Koch; #971 holds the intake list for when a contact exists. |
| 3 | Git host and CI | GitHub Enterprise | GitHub Actions with OIDC; runner label is a variable. |
| 4 | Terraform Enterprise or S3 state? | Unknown | S3 backend with native locking, written so a move to TFE is a backend swap. |
| 5 | Compute | ECS Fargate | No Kubernetes; Terraform is the reconciler. |
| 6 | Identity | Ping; keep magic links "for a bit" | OIDC to Ping with group claims; magic link is a domain-restricted fallback with a sunset date (#982). |
| 7 | Connectors and egress | Microsoft 365, Salesforce, GitHub Enterprise first; Google, Notion, Brave, PostHog dropped | Provider switches per environment (#973); Microsoft 365 facade is new work (#984). |
| 8 | Cross-region Bedrock inference; share the Koch chat tool's gateway? | "No" (ambiguous on a two-part question) | **Open.** Inference-profile prefix is a variable (#972); own quota assumed; both are intake questions. |
| 9 | Tenancy | One Koch-wide instance, Georgia-Pacific first, business units as groups | Group substrate at Tier 3 (#986). |
| 10 | Timeline and operator | 10 users in Q1 2027; Rob plus agents operate until 100 | Sets the Tier 1 date. |
| 11 | Personal account | Stays as the cheap sandbox on the same Terraform; sleep/wake (#964) applies only there | `firewall_mode` and sizing are per-environment variables. |

## 1. Where we are (verified)

| Area | Today | Why it matters for the move |
|---|---|---|
| Account | One personal AWS account, one environment (prod). No staging (#697). | Nothing rehearses a change before production. |
| Network | Default VPC, public subnets, public IPs on every task, no NAT, no VPC endpoints, internet-facing ALB, no WAF. AgentCore runtime in `PUBLIC` mode and it calls back to the app's public URL. | The opposite of a firewalled posture. Biggest single rework. |
| IaC | 4 CDK stacks (1,819 lines). The VPC, RDS, DB security group, main ECR repo, app secret, parent CodeBuild project + role + webhook, SNS topic, 5 alarms, ALB log bucket, SES identity are **not** in IaC. | The platform cannot be rebuilt from the repo (#467). |
| Deploy | Push to `main` → CodeBuild webhook → build 5 images → snapshot → migrate prod → raw CloudFormation update of AgentCore → `cdk deploy` → smoke. Two scripts mutate infra on every deploy. Tags, not digests. | Push-based, imperative, single target. Good receipts, not GitOps. |
| Identity | NextAuth with GitHub OAuth + email magic link, invite gate (20 invites/hour/admin). No OIDC provider, no SCIM, no groups, no session revocation, deleting a user cascades their data. | Blocker for any enterprise rollout (#491). |
| Tenancy | Everything keyed by `user_id`. Org instructions, model enablement, tool catalog, budgets are global. `admin` reads every user's threads. | Fine at 10, a governance problem at 1,000. |
| Scale limits | One 0.25 vCPU worker, 3 concurrent runs, global FIFO. Scheduler ≈ 1,200 enqueues/hour. Web max 4 tasks, model turns held in the web process. DB write on every API call, 500 ms run polling, no pooler, blobs in Postgres. One shared Bedrock daily quota, no per-user caps. | See §6 for what breaks at each tier. |
| Egress | GitHub.com, api.githubcopilot.com, Google, Notion, Salesforce, Brave, PostHog, arbitrary `web_fetch`. Inbound GitHub webhooks. | Every one needs an allowlist decision or a replacement. |
| Live DB (corrects stale docs) | `db.t4g.micro`, single-AZ, **encrypted, 7-day backups, deletion protection on, not public**. | Docs/security/README still says otherwise. |

What is already right and carries over unchanged: per-user data scoping, the tri-state tool policy and
approvals, the audit ledger, the eval gate, stateless web tasks, lease-fenced workers, `prepare:false`
DB client (pooler-ready), no local-disk state, expand-only migration guard.

## 2. Principles

1. **Rebuild, do not lift.** The Koch environment is created from Terraform in a Koch account. Nothing is
   imported from the personal account except, optionally, data. CDK is retired, not translated line by line.
2. **Git is the only way anything changes.** No console, no laptop scripts, no deploy-time mutation.
   A deploy is a merged pull request that changes an image digest or a variable.
3. **Build once, promote by digest.** One image set per commit, signed, promoted dev → stage → prod.
4. **Rehearse the firewall before we are inside it.** Stand up a "firewall-mode" environment in the
   personal account (private subnets, endpoints, proxy-only egress, internal ALB) so every break shows up
   where it is cheap.
5. **Scale work is trigger-based.** Each tier in §6 has entry criteria. Nothing for 10,000 is built at 10.
6. **Koch's paved road wins.** Wherever Koch has a standard (network, IdP, CI, Terraform platform,
   registry, logging), we adopt it rather than bring our own. The app only needs a container runtime,
   Postgres, Bedrock, an OIDC IdP, and an outbound allowlist.

## 3. Target architecture inside the firewall

- **Accounts:** Koch-vended AWS accounts, one per environment (dev, stage, prod), plus Koch's shared
  network/logging/security accounts. Evals run in dev's Bedrock quota, never prod's (#706).
- **Network:** Koch-provided VPC, private subnets only, attached to the corporate network. **Internal**
  ALB on a Koch DNS name with a Koch-issued certificate. No public ingress.
  Interface endpoints: `bedrock-runtime`, `bedrock-agentcore`, `secretsmanager`, `kms`, `logs`,
  `monitoring`, `ecr.api`, `ecr.dkr`, `sts`, `email-smtp`/SES (or Koch SMTP relay); S3 gateway endpoint.
  All other egress through Koch's proxy with an explicit host allowlist.
- **Compute:** ECS Fargate (web, chat-worker, memory-worker, browser-proxy, one-off migrator/smoke tasks).
  AgentCore runtime and Studio Browser in **VPC mode**. If Koch's paved road is EKS + Argo CD, the same
  images and config contract deploy there; the app does not care.
- **Data:** RDS PostgreSQL Multi-AZ behind RDS Proxy, customer-managed KMS key, 35-day PITR. S3 (KMS) for
  uploads/artifacts instead of base64 in Postgres. Secrets Manager with rotation.
- **Identity:** OIDC to Ping. Roles and groups from claims. SCIM for joiner/leaver at Tier 2. GitHub
  sign-in removed from this build; magic link kept as a domain-restricted fallback until its sunset date.
- **Models:** Bedrock in the Koch account, IAM scoped to named models, Guardrails on, residency decision
  on `us.*` cross-region profiles recorded.
- **Observability:** structured JSON logs, OpenTelemetry traces/metrics (#777), CloudWatch → Koch SIEM;
  audit log exported append-only to S3 with object lock (#457).
- **Connectors:** Microsoft 365 (Graph), Salesforce and GitHub Enterprise first. Google, Notion, Brave and
  PostHog are switched off for this build.

## 4. Terraform design

```
infra/terraform/
  modules/            # no environment knowledge, versioned, tested
    network/          # subnets lookup or creation, endpoints, security groups
    data/             # rds, rds-proxy, kms, s3 buckets, secrets shells
    edge/             # alb, listeners, certificate, dns, waf
    ecs-service/      # one service: task def (image by digest), autoscaling, alarms
    agentcore/        # runtime, browser, credential providers
    observability/    # log groups, metric filters, alarms, dashboards, sns
    ci-identity/      # OIDC provider + plan/apply roles
  stacks/             # root modules; one state file each
    00-foundation/    # kms, ecr (immutable tags, scan, lifecycle), ci roles
    10-network/
    20-data/
    30-platform/      # cluster, alb, namespace
    40-services/      # the only stack a normal deploy touches
    50-agentcore/
    60-observability/
  envs/
    dev/  stage/  prod/      # backend.hcl, env.tfvars, release.auto.tfvars (image digests)
```

- **State:** S3 backend with native locking and KMS, one bucket per account, one key per stack (or Koch's
  Terraform Enterprise workspaces if they mandate it). State split by blast radius: a deploy can only touch
  `40-services`/`50-agentcore`.
- **No hard-coded identity.** Account, region, domain, repo, VPC, subnets, IdP issuer come from
  `env.tfvars`. Fixed names get an environment prefix. This removes every item in the hard-coded list
  (runtime ARN, role physical names, security group id, zone id, AZ names).
- **Imperative scripts disappear.** DB perimeter becomes Terraform-owned security group rules (the
  reconciler turns into a drift check). AgentCore image update becomes a digest variable. Alarms, SNS,
  log bucket, ECR, pipeline roles all move into modules. The `DeploymentSequence` machinery is replaced by
  Git history plus state locking.
- **Policy as code:** `terraform validate`, `tflint`, Checkov/Trivy config scan, and OPA/Conftest rules on
  the plan JSON (no public IPs, no `0.0.0.0/0` ingress, encryption on, required tags, no IAM `*` on
  Bedrock). Koch's own Sentinel/OPA policy set replaces ours where it exists.
- **AgentCore coverage:** the AWS provider has `aws_bedrockagentcore_*` resources. Verify runtime VPC
  mode, custom browser, and credential providers on the pinned provider version in a spike; fall back to
  the `awscc` provider for any gap. This is the one technical unknown in the Terraform port.
- **Tests:** `terraform test` per module, plus the existing CDK assertion tests rewritten against plan JSON
  (they encode real invariants: task floors, alarm thresholds, IAM scope).

## 5. GitOps flow

**Application repo (this one)**
1. PR: lint, typecheck, unit, integration, mock evals, migration guard, Terraform plan for dev (comment on
   PR), policy checks. Claude review + `needs-rob` gate stay as they are.
2. Merge to `main`: build the image set once, generate SBOM, scan, sign (cosign/KMS), push by digest to
   ECR. A bot opens a PR that bumps `envs/dev/release.auto.tfvars`. Auto-merge on green → dev deploys.
3. Promotion: a PR that copies the digest set dev → stage, then stage → prod. Prod requires a named
   approver (CODEOWNERS + protected environment) and a green stage smoke + eval pack on that digest.
4. Apply on merge: `plan` is re-run and must match the reviewed plan; migrator task (expand-only) →
   `40-services` apply with `wait_for_steady_state` and the circuit breaker → in-VPC smoke → receipt
   committed back as a deployment record.
5. Rollback is `git revert` of the release PR. Database changes follow expand/contract, two releases.

**Guardrails**
- CI authenticates with OIDC only; plan role is read-only, apply role is assumable only from the protected
  branch/environment. No long-lived keys anywhere (retire the `local-dev` IAM user for the Koch build).
- Nightly `terraform plan -detailed-exitcode` on every stack; drift opens an issue.
- Break-glass is a documented, alarmed role; any use must be reconciled into Git within a day.
- Branch protection, signed commits, CODEOWNERS on `infra/` and `envs/prod/`.
- One Git host is the source of truth: Koch's GitHub Enterprise. Self-hosted runners inside the
  network if hosted runners cannot reach the accounts.

**Why Terraform-PR GitOps and not Argo CD:** the workload is ECS, so the reconciler is Terraform itself.
Rob chose ECS. If Koch later mandates EKS, `40-services` becomes a Helm chart reconciled by Argo CD and
stacks 00–30 are unchanged.

## 6. The scale ladder

Each tier lists what must be true **before** opening to that many people. Issue numbers are existing backlog.

**Tier 0 — firewall-ready (before any Koch user)**
- App portability: all account/domain/repo values from config; images by digest; PostHog token out of the image.
- Terraform stacks + GitOps pipeline running dev and stage in the personal account, firewall-mode proven.
- Ping OIDC sign-in with group claims; `users.status`; session revocation; scoped admin (#982, #983).
- Internal-only topology works end to end: AgentCore VPC mode, MCP facades on an internal URL, no
  inbound webhooks (poll or GitHub Enterprise in-network), proxy-aware outbound HTTP.
- Security pack current: threat model, data flow, residency record, pen-test scope (#453 Track A, #492).

**Tier 1 — 10 users (pilot inside the firewall)**
- dev/stage/prod accounts live from Terraform; restore drill done once; on-call = Rob + alarms.
- Per-user daily spend cap and Bedrock quota alarm on the model actually in use.
- Scoped admin: admins no longer read other users' threads by default; access is audited (#453).
- Entry cost estimate to confirm: ≈ $600–900/month per always-on environment before model spend
  (Multi-AZ RDS, 2 AZ of interface endpoints, ALB, 5 small tasks). Dev/stage run single-AZ and smaller.

**Tier 2 — 100 users**
- Worker: `FOR UPDATE SKIP LOCKED` claim, per-user fairness, autoscale on queue depth (#443, #448).
- RDS Proxy on; drop the per-request `last_seen_at` write; replace 500 ms polling with SSE/long-poll.
- OTel traces, queue-depth and p95 alarms, SLOs written down (#449, #777).
- Load test in stage at 2× target concurrency (#696); WAF on the internal ALB (#691).
- Audit export to SIEM; retention jobs scheduled (#457, #460).
- SCIM deprovisioning wired to token revocation (#836, #692).

**Tier 3 — 1,000 users**
- Group/BU substrate: `groups`, memberships from IdP; group-scoped shares, policy, budgets, instructions (#491).
- Scheduler: batch claim or EventBridge Scheduler; durable dispatch moves to SQS.
- Uploads/artifacts to S3; `run_events` and `audit_log` partitioned by month; online migration path
  (non-transactional index builds).
- Web scales on request count; long tool turns move off the web tier.
- Bedrock: quota increases, default routing to the cheapest qualified model, chargeback per BU (#734).
- A second operator and a real on-call rotation. Delegated BU admins.

**Tier 4 — 10,000 users**
- Aurora PostgreSQL with a reader for admin/reporting; connection budget enforced.
- Provisioned throughput or cross-region capacity plan; admission control and queueing under throttling.
- DR: cross-region backups, timed restore, stated RPO/RTO; optionally a warm second region.
- Per-BU policy and model enablement; catalog/skills governance at org scale (#412, #495).
- Support model: status page, runbooks owned by a platform team, adoption dashboard (#945).

## 7. Sequence

| Phase | Outcome | Size | Needs Koch? |
|---|---|---|---|
| P0 Discovery (#971) | Intake answers; landing-zone contract written as an ADR | S | Yes |
| P1 Portability (#972, #973) | Config contract, digests, no hard-coded identity, proxy-aware HTTP, OIDC provider behind a flag | M | No |
| P2 Terraform in the personal account (#974–#977, #980) | New VPC + all stacks; dev and stage from code; data restored from snapshot; DNS cut over; CDK stacks and CodeBuild project deleted | L | No |
| P3 GitOps pipeline (#978, #979) | Build-once/promote, plan-on-PR, apply-on-merge, policy checks, drift detection | M | No |
| P4 Firewall rehearsal (#981) | Firewall-mode env passes the full smoke + eval pack with proxy-only egress | M | No |
| P5 Identity (#982, #983) | OIDC + groups + status + revocation; SCIM stub | M | IdP test tenant |
| P6 Koch landing (#984, #985) | Same Terraform applied to Koch dev → stage → prod; security review; 10 users | M | Yes |
| P7+ Ladder (#986) | Tier 2, 3, 4 work, each started when its trigger is near | L each | Partly |

P1–P5 need nothing from Koch and close #467, #697, most of #492 and the first child of #491. Running the
personal account in firewall mode full-time costs more than today's idle profile (#963/#964), so firewall
mode is a variable: on for rehearsals, off for the cheap always-on sandbox.

## 8. Risks

- **AgentCore in VPC mode + Terraform coverage** is unproven here. Spike it first in P2.
- **Connector value inside Koch.** If Google/Notion/GitHub.com are not allowed, the demo arc needs
  Microsoft 365 and GitHub Enterprise connectors that do not exist yet.
- **Koch's platform may dictate EKS, a different CI, or Terraform Enterprise.** Keeping the app contract
  small (container, Postgres, Bedrock, OIDC, allowlist) limits the cost of being wrong.
- **Frontier model access** is still blocked in the personal account (#920); the Koch account has its own
  model-access process.
- **One operator.** GitOps reduces the bus-factor risk but Tier 3 needs a second human.

## 9. Issue map

| Issue | What |
|---|---|
| #970 | Epic |
| #971 | P0 landing-zone contract: intake questions and ADR |
| #972 | P1 configuration contract: no hard-coded account, region, domain, repo, ARN |
| #973 | P1 proxy-aware outbound HTTP, egress inventory, provider switches |
| #974 | P2 Terraform foundation: layout, state, CI identity, registry, keys, policy checks |
| #975 | P2 network and data stacks, `firewall_mode` |
| #976 | P2 platform, services and observability stacks, images by digest |
| #977 | P2 AgentCore in Terraform, VPC mode spike |
| #978 | P3 build-once pipeline: SBOM, scan, sign, release pull request |
| #979 | P3 plan on PR, apply on merge, promotion, drift detection |
| #980 | Cut the personal account over to Terraform; delete CDK and CodeBuild |
| #981 | P4 firewall rehearsal |
| #982 | P5 Ping OIDC with groups; magic-link fallback |
| #983 | P5 user status, session revocation, scoped admin |
| #984 | P6 Koch connector set: Microsoft 365, GitHub Enterprise, Salesforce |
| #985 | P6 land in the Koch accounts; security review pack; 10 users |
| #986 | Scale ladder tracker: 100, 1,000, 10,000 |

Existing issues absorbed or sequenced: #467 and #697 close with #980; #492 child 1 with #975/#981;
#491 child 1 with #982; #691, #706, #443, #448, #449, #777, #696, #457, #460, #836, #692, #734, #923,
#412, #495, #945 sit on the ladder in #986.
