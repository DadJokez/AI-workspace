# Comparative Idle-Cost Profile

## Authorization and Intent

Rob approved: "Make it as low cost as possible w/o shuttering it completely".
The operations below were applied on 2026-11-13 UTC to account 351478076796,
region us-east-1. They retain the existing application and data, not a static
maintenance page. Single-task web availability is an explicit tradeoff.

## Applied Operations

| Surface | Before | Idle-cost setting |
| --- | --- | --- |
| Nightly Evals | Daily real-model runs | Workflow disabled manually immediately; this PR removes the schedule so it can be re-enabled for manual runs after merge |
| Legacy App Runner `ai-workspace` | Running | Paused, not deleted; neither public domain routes to it |
| ECS web autoscaling | Minimum 2, maximum 4 | Minimum 1, maximum 4; CPU scaling remains enabled |
| ECS web desired count | 2 | 1 |
| Web task-floor alarm | Threshold 2 | Threshold 1; SNS actions and missing-data detection preserved |
| Web task placement | Six default-VPC public subnets | us-east-1c and us-east-1e |
| Public ALB | Six enabled zones | Same two zones as web; cross-zone routing retained |
| ECR `ai-workspace` | 1,574 image manifests | 111 retained; 1,463 old Docker manifests removed successfully |

The live ECS/network/alarm adjustments precede the matching CDK changes in this
PR. Until the PR merges, deploying main's old CDK template can restore the old
capacity/network settings. Do not treat those adjustments as permanently
reconciled until the updated template is deployed through the usual review gate.

No database, snapshot, application file, upload, user-created deliverable, secret,
IAM policy, model selection, worker count, or security boundary was changed.
Chat, memory, and browser-proxy workers each remain at one task. The database
remains available with deletion protection enabled. Production runs commit
`04ae5d74d0478b5953968ee36e71a06e61caa3d1`; no application code was deployed.

## Image Retention

Only the `ai-workspace` repository was cleaned. `jermes`, CDK assets, and
`ai-workspace-agentcore-agent` were untouched. Candidates had to be older than
60 days and either untagged or exclusively tagged with recognized release
commit tags. Named/custom images and non-Docker manifests were preserved.

All images referenced by current service deployments, running/pending tasks,
and App Runner were protected. The newest 20 release commits across the web,
worker, memory-worker, migrator, and smoke families were retained as whole
release cohorts. Current release images were rechecked after cleanup.

Older deleted image bytes cannot be restored by undoing a setting. A rollback
outside the retained window requires a rebuild of the historical source commit;
rebuilding is not a guarantee of byte-identical historical output. Deletion
receipts and exact retained/candidate digests are saved locally at
`/Users/roblindmark/code/comparative-cost-audit-20261113/` in `applied-plan.json`
and `deletion-results.json`. No credentials are included in those files.

The candidate manifests sum to 369.45 GB, but that is NOT the amount of billed
storage recovered: ECR layers are shared. Use subsequent Cost Explorer storage
usage to measure actual savings.

## Verification and Budget

After the changes, HTTPS `/api/health` returned 200 with database and runtime
checks OK, and `/chat` redirected to a working 200 login page. A new web task
registered healthy before the old target drained. The current web, chat-worker,
and memory-worker image tags still resolve in ECR. This is an infrastructure
smoke check, not a new authenticated end-to-end model/chat evaluation.

October account-wide unblended cost was $257.48, including $83.43 for Bedrock,
$64.19 for ECS, $40.93 for public IPv4, $17.36 for ECR, $16.76 for the ALB,
$15.93 for RDS, and $11.42 for App Runner. These are account totals, not exact
resource-tag attribution. Daily evaluations are a likely large part of the
model spend, not a proven attribution of every model request.

Planning estimate: about $110-130/month at idle after these changes, not a hard
cap. User activity, autoscaling, storage growth, and unrelated account resources
can increase it. Compare complete daily billing periods after cost data settles.
PR CI, dependency audits, and security/merge checks remain enabled. Scheduled
Product Smoke is unchanged; it is not the paid real-model evaluation lane.

## Restore Active Development

1. After the manual-only workflow change merges, enable it using
   `gh workflow enable nightly-evals.yml --repo DadJokez/AI-workspace`.
   Until then, enabling it also resumes the daily schedule from old main.
   Run manual evaluations with `gh workflow run nightly-evals.yml` after enabling.
   Restore its daily cron in a reviewed PR when regular development resumes.
2. Restore `WEB_MIN_TASK_COUNT` to 2 in CDK, update its regression test, and deploy
   through CI/review. For urgent operational restoration, set the ECS scalable
   target minimum to 2, the web desired count to 2, and the task-floor alarm
   threshold to 2 together. Keep the maximum at 4 and all alarm actions intact.
3. Two ALB zones are enough for the normal configuration. If more zones are
   needed, expand ALB subnets FIRST, then web task placement to match. Never
   schedule web tasks in zones disabled on the ALB.
4. App Runner can stay paused indefinitely. Resume it only for an intentional
   legacy recovery, using `aws apprunner resume-service` with ARN
   `arn:aws:apprunner:us-east-1:351478076796:service/ai-workspace/e78909142ef74a37ba25f7cd95fe0d09`.
   Resuming it alone does not change public DNS. Its source remains `latest`
   with auto-deploy configured, so review that before using it as a rollback.
5. Verify ECS stability, target health, `/api/health`, sign-in, and a real chat
   after restoration. Do not remove database protection or data to save costs.
