# Comparative Sleep/Wake: Design and Cost Decision

Status: proposed, planning only. Epic: [#964](https://github.com/DadJokez/AI-workspace/issues/964).
Prepared November 12, 2026 (America/New_York); AWS facts/prices checked
2026-11-13T00:53:54Z. No sleep/wake infrastructure has been deployed.

## Decision

Recommend proving **hibernation of the existing application and RDS instance**,
not immediately migrating PostgreSQL to Aurora or rewriting Next.js for Lambda.
Rob accepts startup delay. Preserve the same database and application semantics.
Stage A retains the ALB to prove safe sleep/wake; Stage B removes its idle fixed
cost only after recreating stateless ingress is demonstrably reliable.

This is not a promise of $0 or instant startup. Storage, backups, keys, secrets,
DNS, and the wake controller remain. AWS documents RDS startup as **minutes to
hours** [S1]. Measure startup and communicate actual progress, not a fake ETA.
Target p95 <=15 minutes for the spike, with an alert after 20 minutes and an
honest delayed/retry state. If startup misses that target, do not silently
declare success: present measured latency and cost alternatives to Rob.

## Current Facts and Constraints

- Region/account: us-east-1 / 351478076796. Production image commit 04ae5d7.
- RDS `ai-workspace-db`: PostgreSQL 16.13, db.t4g.micro, private, encrypted,
  20 GB allocated storage, seven-day backups, deletion protection enabled.
- October bill: $257.48 account-wide, including $83.43 model usage. This is
  historical billing, not the post-#963 run rate. Reduced always-on estimate is
  $110-130/month; actual post-change spend must still be measured.
- #963 operations are live but its PR is unmerged. CI includes failing CVE and
  browser checks; do not bypass them. Reconcile that baseline before rollout.
- Web is 0.5 vCPU/1 GB; three workers are each 0.25 vCPU/0.5 GB. One task per
  service remains; web autoscaling can expand to four. No NAT gateway assumed.
- `packages/db/src/client.ts` uses postgres-js pools, not Data API; `/api/health`
  queries PostgreSQL. Such polling/connections must not keep a sleeping system
  alive or wake it merely for monitoring.
- `apps/web/lib/chat-run-worker.ts` polls and claims jobs with leases/fencing.
  `apps/web/lib/schedules/scheduler.ts` runs in the chat worker. Stopping that
  process without externalizing wake scheduling would silently miss schedules.
- `apps/web/scripts/memory-capture-worker.ts` runs another DB polling loop.
- `apps/web/lib/auth/nextauth.ts` uses JWT sessions. Wake authorization may verify
  existing valid sessions offline, but revocations require an independent mirror.
- Artifact content is persisted in PostgreSQL (`workspace-artifacts.ts` and
  `packages/db/src/schema.ts`). Inventory ALL other storage paths before sleep:
  attachments, versions, app state, trace blobs, browser downloads, sandbox files.
  No assumption that container-local or AgentCore session files are disposable.

## Options and Prices

Assume 730 hours/month, Linux x86 Fargate, on-demand prices, no free-tier credits,
no reservations, no new NAT/interface endpoints, no always-on WAF subscription.
WAF/security requirements must be priced if added, never omitted to meet a target.
Model tokens, AgentCore sessions, excess traffic, tax, unrelated projects, and
engineering labor are additional. No paid nightly model evaluations.

| Option | Fully idle | 40 awake hours | 120 awake hours | 730 awake hours |
| --- | ---: | ---: | ---: | ---: |
| Reduced always-on baseline | $110-130 | $110-130 | $110-130 | $110-130 |
| A: stop ECS/RDS, keep two-zone ALB | $43.73 | $47.95 | $56.41 | $120.90 |
| B: A plus temporary/recreated ingress | $20.00 | $25.53 | $36.59 | $120.90 |

These are central planning estimates, not quotes or observed savings. B's idle
range is $15-25. A's idle range is $40-50. All awake-hour totals include startup,
shutdown/drain, 30-minute idle grace, maintenance, automatic DB restarts, and
scheduled work; 40 hours typing can easily exceed 40 billed hours. For example,
60 separate sessions add up to 30 idle-grace hours before startup overhead.

### Reproducible Arithmetic

Live AWS Pricing API confirms RDS micro $0.016/hour (SKU 9HPEGXQTDDGH53C9) and
Aurora PostgreSQL Serverless v2 $0.12/ACU-hour. October billing confirms RDS
storage $2.30 for 20 GB and excess backup $1.72 for 18.15 GB-month.

| Input | Rate/allowance | Evidence |
| --- | ---: | --- |
| Fargate x86 vCPU | $0.04048/vCPU-hour | [S2] |
| Fargate memory | $0.004445/GB-hour (rounded) | [S2] |
| Four application tasks total | 1.25 vCPU + 2.5 GB = $0.0617125/hour | CDK sizes |
| Task public IPv4 | 4 x $0.005 = $0.020/hour | [S3] |
| ALB | $0.0225/hour, plus $0.008/LCU-hour | [S4] |
| Two ALB IPv4 | $0.010/hour | [S3] |
| Running RDS | $0.016/hour | Pricing API, existing account bill |
| LCU allowance | 1 LCU for every awake hour = $0.008/hour | assumption |

Fixed central allowance F=$20/month: DB storage $2.30, charged backups $2,
KMS $3, Secrets Manager $3, DNS $1, retained ECR images $3, S3 $0.50, and
$5.20 for wake-control/edge requests/logs/alarms and uncertainty. Those allowances
must be replaced with measured resource-level values; ECR billing after cleanup
is not yet known. Control sizing assumes <=100k requests, <=10 GB delivery,
<=100 wake operations/month, one five-minute watchdog, and bounded logs.

Let H be total awake hours:

```
application + DB + assumed LCU = 0.0617125 + 0.020 + 0.016 + 0.008
                             = 0.1057125 dollars/hour
retained ingress             = 0.0225 + 0.010 = 0.0325 dollars/hour
A = 20 + 730 * 0.0325 + H * 0.1057125
B = 20 + H * (0.1057125 + 0.0325)
```

ALB partial-hour rounding can add less than $0.0225 per wake; RDS has a
ten-minute minimum per start [S1]. Add both to measured projections rather than
hiding repeated short sessions. Releasing a zone does not instantly remove all
billed ENIs; include teardown lag in cost measurement.

At 40 awake hours, B saves about $84/month against the conservative $110
baseline. At continuous use it offers no dependable savings. For >=50% savings
against $110, the central B model needs H <=253 hours/month; require headroom
and use measured values rather than treating that boundary as a guarantee.
If implementation cost were $2,000, $84/month saves it back in ~24 months;
at $5,000, ~59 months. These are illustrative labor costs, not an estimate or quote.

### Why Not Aurora/Lambda First?

Aurora supports auto-pause at zero ACUs on compatible versions [S5], but an
average 0.5/1/2 ACUs while awake costs $0.06/$0.12/$0.24 per hour. At 120 awake
hours that is $7.20/$14.40/$28.80 for DB compute alone versus $1.92 for our RDS.
Persistent connections inhibit auto-pause. A DB migration therefore does not
automatically lower the bill and adds restore, schema, and compatibility risk.

Lambda + CloudFront removes ALB base charges [S6]. However, our private DB,
external connectors, long streams, large uploads and browser proxy make this a
real migration. Data API has 64 KB row / 1 MiB result limits [S7], problematic
for inline artifacts and transcripts. VPC Function URL streaming has documented
restrictions [S8]; NAT/endpoints or a different integration change the budget.
Do not assume an adapter swap preserves the current app or costs pennies.
Revisit only if measured hibernation latency is unacceptable; separately model
Lambda GB-seconds (including open streams), API requests, DB ACUs/I/O, networking,
and retained workers. No serverless migration approved by this document.

## Proposed Architecture

### Always Available Control Plane

- CloudFront custom domain, private S3 waiting page, small authenticated Lambda
  wake/status API, DynamoDB on-demand state/leases, Step Functions Standard for
  orchestration, EventBridge for schedules/watchdog. None depends on RDS.
- Existing session can authorize wake only, not grant new app access. For an
  expired session, send a single-use short-lived email wake link only to a
  pre-enrolled active user mirrored while the DB is awake. Generic responses
  prevent account enumeration. Normal app authentication still follows wake.
- Signed scoped cookie/token, CSRF defense, IP/user throttles, TTL/nonces and
  revocation mirror. An arbitrary GET, bot, health probe or failed login cannot
  start paid infrastructure. Admin can revoke wake independently during sleep.
- DynamoDB owns a conditional generation/lease for OFF, STARTING, ON, DRAINING,
  STOPPING, FAILED. CloudFront edge state is routing-only and eventually
  consistent, never authoritative permission to write or terminate resources.
- `READY` means DB reachable, all required workers healthy, web target healthy,
  normal authentication usable, correct release loaded. Show component progress
  and a safe retry path. Failed starts alert; capped retries prevent cost loops.

### Stage A: Prove Sleep While Keeping Ingress

Keep ALB/listeners/security groups/TLS/DNS. Wake starts the SAME RDS instance,
then the web/workers at recorded counts with pinned image digests. No migrations
or builds on wake. Edge shows waiting UI while starting and routes through ALB
only when ready; POST/API requests receive retryable 503, not a fake 200 page.
Do not proxy or buffer large uploads or long chat streams through the controller.

### Stage B: Remove Idle Ingress Cost

Split ownership deliberately: permanent data/security/control resources versus
recreatable ALB/listeners/target groups and their service associations. The
existing monolithic CDK stack cannot simply be deleted/recreated. Before
production, prove a no-replacement refactor/import with a reviewed change set;
no DB, secret, key, storage, namespace, or browser resource may be replaced.

When asleep remove ONLY the explicit stateless ingress resources; retain DNS
zone/certificates and restrictive SGs. On wake recreate ingress, attach the new
target group to the ECS service, verify targets, then route the fixed public
domain through CloudFront. A fixed origin hostname with an ACM-valid name can
be repointed to the new ALB. Test DNS/edge stale-origin windows and keep the
waiting state until propagation and HTTPS are proven. CloudFront dynamic-origin
helpers are available [S9], but choose the simpler verified mechanism in the
spike; do not assume an edge config update is instantaneous.

Restrict ALB ingress to the approved CloudFront origin path plus authenticated
origin checks; preserve all app authorization and generated-content isolation.
Do not cache personalized responses, cookies, authorization, upload responses,
or stream events across users. Test host forwarding, callback URLs, CSP,
WebSockets/AgentCore browser sessions, and streaming with the added front door.

## Safe Shutdown and Work Scheduling

1. Eligible only after 30 minutes without meaningful user activity AND no
   accepted work: HTTP writes/streams/uploads, queued/running jobs, memory
   captures, publication jobs, due schedules, migrations/deployments, active
   browser/sandbox sessions, or unpersisted files. Idle polling is not activity.
   Uncertain session/file state blocks sleep rather than discarding it.
2. Atomically acquire a fenced drain generation. Application write admission
   consults the authoritative gate; stale edge state cannot admit a write after
   it closes. Fence all writers, not just the browser, including connectors,
   workers and admin jobs. An authenticated new wake during drain cancels it.
3. Stop claiming new work, let accepted operations finish, persist final output
   and checkpoints, close DB pools, reconcile pending-job counts and active
   leases. Timeout => abort sleep and alert; do not forcibly kill unfinished work.
4. Verify a recovery point after quiescence (initially an encrypted on-demand
   snapshot), retain prior verified recovery points, then scale compute to zero.
   Stop RDS only after every writer is drained. Stage B may then remove ingress.
   Mark OFF only after AWS resource state agrees; failed shutdown stays explicit.
5. Accepted messages receive success only after durable commit. Retry uses
   idempotency keys; lease ownership and external-tool idempotency/reconciliation
   survive wake. Never promise exactly-once third-party side effects.

Mirror future schedules into EventBridge with versioned idempotent create/update/
delete and reconciliation before sleep. Pre-wake using measured startup lead
time; overdue behavior is explicit. Capture verified webhook events durably in
SQS (large payloads in encrypted S3) before acknowledging them; signed events
request wake, invalid events do not. DLQ/retention/replay must prevent expiration
from silently dropping accepted work. Do not disable schedules to hit the budget.

RDS automatically starts after seven stopped days [S10]. Use event-driven handling
plus a five-minute control-only watchdog to observe it. When desired state is
still OFF, wait for maintenance/backup completion, check the generation, then
stop again. Never race an authorized wake; never block maintenance. Account for
periodic compute time, alarms and recovery-point retention. Monitoring must not
query the sleeping DB. Application-unavailable alarms distinguish intentional
OFF from failed wake; controller/security/backup failure alarms stay live.

## Data Protection and Rollback

- Planned transitions have a **zero acknowledged-write loss acceptance target**.
  This is not an absolute disaster-proof guarantee. Single-AZ failures and
  backup recovery have separate measured recovery-point/time objectives.
- No database deletion, no snapshot restore as routine wake, no KMS key deletion,
  no schema changes unless separately reviewed. Preserve encryption, private
  DB access, deletion protection, and seven-day recovery policy.
- Inventory and hash all durable stores. Prove chats, users, auth records,
  encrypted connector credentials, memories, uploads, app versions, feedback,
  schedules and artifacts survive cycles. Never read/export secret values into
  logs, issue bodies or verification reports.
- Snapshot-before-first-transition and restore drill into a private isolated
  DB. Retain latest successful and previous recovery points until replacements
  are verified. Price incremental backups and cap retention without deleting the
  only known-good recovery point. Stopped DB backup behavior needs explicit
  coverage, not an assumption of continuous PITR while offline.
- Rollback: disable automatic sleep, start existing DB/services, recreate/retain
  ingress, return routing to the verified awake origin, and confirm sign-in/chat.
  State-generation and deployment locks prevent old deploys undoing sleep state.
- Controller failures fail toward leaving data and compute intact (higher cost),
  not destructive cleanup. An independent admin CLI can restore the awake state.

## Proof, Budget and Release Gates

No production changes or paid spike have been authorized by this planning task.
Propose an isolated synthetic-data spike with **$25 maximum incremental AWS
budget** and <=$5 of optional model calls inside that total. Estimate cost before
each resource launch; use a TTL cleanup/watchdog and named owners. Billing alerts
are delayed and not hard caps. If forecast exceeds budget, stop and request review.

Required evidence before rollout:

- Ten full cycles, including concurrent wake requests, wake during drain, crash
  during each phase, failed target registration, stale edge state, and long task.
- 30-day-equivalent schedule tests plus an unattended seven-day observation of
  actual RDS auto-restart. Synthetic event replay alone does not prove that path.
- Row counts/content hashes before and after; boundary-write, upload, cancel,
  retry, restore and no-duplicate-side-effect tests. No changed assertions to pass.
- Playwright: expired/valid sign-in, waiting/retry, saved chats, streaming/resume,
  large supported uploads, artifacts/downloads, published apps, browser sessions.
- Background workloads execute while no user is online. Bots/health checks
  cannot wake or keep it awake. Revoked wake permissions cannot restart compute.
- Per-resource billing tags and measured running hours/ACUs/bytes/requests; compare
  projected totals with a settled #963 baseline, excluding unrelated projects
  consistently. >=50% savings at expected usage and <=$25 truly-idle projection
  for B, with startup/drain/weekly maintenance/controller charges included.
- Reject/revise B if its extra complexity does not justify its ~$24/month ingress
  saving over A. No implementation-labor ROI claim without an actual estimate.
- Independent Claude review, CI, Product Smoke, and Rob approval for auth/IAM,
  infrastructure and any migrations. No current red checks bypassed.

## Delivery Backlog

Parent: [#964](https://github.com/DadJokez/AI-workspace/issues/964). Work in this
order only after the relevant approvals; this document authorizes no rollout.

1. [#965: isolated proof and cost measurement](https://github.com/DadJokez/AI-workspace/issues/965).
   The proposed $25 budget needs approval before launching resources.
2. [#966: authenticated wake, safe drain and durable schedules](https://github.com/DadJokez/AI-workspace/issues/966).
   Stage A retains ingress and proves lifecycle safety.
3. [#967: deep-sleep ingress](https://github.com/DadJokez/AI-workspace/issues/967).
   Proceed only if the additional savings justify the infrastructure complexity.
4. [#968: data integrity and measured-savings release gate](https://github.com/DadJokez/AI-workspace/issues/968).
   Requires restore evidence, independent review and explicit production approval.

## Sources

- [S1: RDS start behavior and minimum billing](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_StartInstance.html)
- [S2: Fargate pricing](https://aws.amazon.com/fargate/pricing/)
- [S3: public IPv4 pricing](https://aws.amazon.com/vpc/pricing/)
- [S4: ALB pricing](https://aws.amazon.com/elasticloadbalancing/pricing/)
- [S5: Aurora auto-pause requirements](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html)
- [S6: CloudFront with Lambda URL origins](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistS3AndCustomOrigins.html)
- [S7: Data API limits](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.troubleshooting.html)
- [S8: Lambda streaming and VPC constraints](https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html)
- [S9: CloudFront origin modification](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/helper-functions-origin-modification.html)
- [S10: RDS temporary stop](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_StopInstance.html)
- [Aurora pricing](https://aws.amazon.com/rds/aurora/pricing/)
- [CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/)

Price API commands used (read-only): `aws pricing get-products --region us-east-1
--service-code AmazonRDS` filtered to regionCode=us-east-1 and either PostgreSQL /
db.t4g.micro / Single-AZ or usagetype=Aurora:ServerlessV2Usage. Historical billing
queried through Cost Explorer for 2026-10-01 through 2026-11-01.
