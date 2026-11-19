# Runbook: roll back a release

**Status: written, never executed.**

**Purpose.** Put an environment back on the images it ran before a bad release. Applies to the
environments the Terraform pipeline deploys (`personal-stage` today, production after the cutover,
WP-20). Production on CDK rolls back with `infra/scripts/rollback-ecs.sh` and
[AgentCore rollback](./AGENTCORE_ROLLBACK.md): see [Production deployment](../PRODUCTION_DEPLOYMENT.md),
"CDK (until cutover)".

## The short version

**Revert the release pull request.** A release is one change to one file,
`infra/terraform/envs/<env>/release.auto.tfvars`: the release id and five image digests. Reverting it
restores the previous id and digests, and the merge of the revert deploys them like any release.
Nothing is changed by hand, so nothing has to be reconciled afterwards.

- **The database is not rolled back.** Migrations are expand-only, so the previous code runs against
  the newer schema. CI enforces it (`packages/db/scripts/migration-guard.mjs`: a drop, rename, type
  change, `SET NOT NULL` or data update fails unless reviewed with a `-- migration-guard-allow:`
  marker; see `packages/db/README.md`).
- **AgentCore follows the same revert.** The agent image is one of the five digests in the same file,
  and the apply on merge applies `50-agentcore` with the others (once `50-agentcore` exists; until then
  the agent runtime is not deployed by this pipeline).

## Decide first

| What is wrong | Do |
|---|---|
| The new release is bad (errors, a failed smoke task, a regression) | Revert the release pull request (below). |
| The smoke task failed during the deploy | The apply job has already opened a pull request reverting the merged commit (or, without the release bot, said in its job summary what to revert). Review and merge that one. |
| A change to the infrastructure is bad | Revert that pull request the same way. Its plan comment shows what the revert will change; a revert that destroys or replaces a database, key, bucket, secret or repository needs the label `allow-stateful-replace` from Rob. |
| A migration is bad | Do not roll back. Fix forward with a new migration, through a pull request. If data is lost, see [DB restore rehearsal](./DB_RESTORE_REHEARSAL.md) and the `pre-migrate-*` snapshot the deploy took. |
| The pipeline itself cannot deploy, and waiting is worse | [Break-glass](./BREAK_GLASS.md), then reconcile into Git within one working day. |

## Procedure: revert a release

1. **Find the release pull request.** It is titled `release(<env>): <short sha>` (or
   `promote(<env>): <short sha> from <env>` for a promotion) and changed only `release.auto.tfvars`.
   The last successful deployment says which release runs now:

   ```bash
   gh api "repos/<owner>/<repo>/deployments?environment=<env>&task=terraform-apply&per_page=5" \
     --jq '.[] | {sha, created_at, release: .payload.release_id}'
   ```

2. **Revert it.** On the merged pull request, press **Revert**, or:

   ```bash
   git switch -c revert-release-<short sha> origin/main
   git revert --no-edit <merge commit of the release pull request>
   git push -u origin HEAD     # then open the pull request
   ```

   If a later release has merged since, revert that one first, or make one pull request that sets the
   file to the release you want: any release whose id is a commit on `main` and whose digests are still
   in the registry can be deployed. The registry keeps the last 60 images per component.

3. **Merge it once its checks pass.** It needs the same checks as any pull request. `release is
   signed` (`release-checks.yml`) runs only for a branch named `release/<env>`; for any other branch the
   apply job checks the signatures itself before it applies anything.

4. **Watch the apply** (`terraform-apply.yml`, job `apply <env>`). For a release it:
   verifies every digest's signature; applies `35-deploy-tasks`; takes a `pre-migrate-*` snapshot if
   `packages/db/drizzle` differs between the two releases (it does when the bad release added a
   migration); runs the migrator of the restored release, which applies nothing, because drizzle applies
   only migrations newer than the last one the database records; applies `50-agentcore` and
   `40-services` and waits for the services to be steady; runs the smoke task.

   The revert is a new commit on `main`, so the rule that releases only move forward lets it through.
   Do not re-run the old apply run of the previous release instead: it is refused for that reason.

5. **Confirm.** The job records a GitHub deployment of the revert commit for the environment, state
   `success`, whose payload lists the restored release id and digests, the snapshot id, and the
   migrator and smoke task ARNs with exit code 0. The job summary shows the same JSON.

6. **Fix forward.** The bad change is still in the history of `main`. The next build of `main` builds
   whatever `main` holds, so fix the cause before the next release pull request merges.

## If the revert fails to deploy

The job fails and says where. A failed `40-services` apply leaves ECS on the last steady task set (the
deployment circuit breaker rolls back a task set that does not become healthy). Read the job log,
fix the cause in a pull request, and merge it; do not change the services by hand unless
[break-glass](./BREAK_GLASS.md) applies.
