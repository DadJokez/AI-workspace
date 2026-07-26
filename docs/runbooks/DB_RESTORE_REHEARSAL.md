# Runbook: database restore-from-snapshot rehearsal

**Status: written, never executed.** `docs/security/THREAT_MODEL.md` T14 lists
"no restore drill" as residual risk. This runbook makes the drill executable;
running it is what discharges the risk.

**Purpose.** Prove that `ai-workspace-db` can actually be restored from an
automated backup, and measure how long it takes. Recovery you have not
rehearsed is a hope, not an RTO.

**This is a rehearsal, not a cutover.** It restores into a *new, isolated*
instance and never touches the live one. Production traffic is unaffected at
every step. The only production action in the entire procedure is creating a
manual snapshot (step 2), which is non-disruptive on a Multi-AZ-less instance
apart from brief I/O.

## Verified starting state (2026-07-25)

```
$ aws rds describe-db-instances --region us-east-1 \
    --db-instance-identifier ai-workspace-db \
    --query 'DBInstances[0].{engine:EngineVersion,enc:StorageEncrypted,pub:PubliclyAccessible,multiaz:MultiAZ,backup:BackupRetentionPeriod,delprot:DeletionProtection}'
{ "engine": "16.13", "enc": false, "pub": true, "multiaz": false,
  "backup": 1, "delprot": false }
```

Read that carefully before drilling: **backup retention is one day.** The
recovery window is 24 hours. Anything discovered on day two is not recoverable
from automated backups.

## Prerequisites

- AWS credentials with RDS and EC2 describe/create rights in `us-east-1`.
- The DB security group id and the subnet group, both read at run time (this
  repository is public, so live resource identifiers are looked up rather than
  written down):
  `aws rds describe-db-instances --db-instance-identifier "$DB_INSTANCE" --query 'DBInstances[0].[VpcSecurityGroups[0].VpcSecurityGroupId,DBSubnetGroup.DBSubnetGroupName]' --output text`
  subnet group used by the live instance — read them, do not assume them.
- A wall clock. **Record timings**; the numbers are the deliverable.

## Procedure

### 1. Record the starting facts

```bash
export AWS_DEFAULT_REGION=us-east-1
aws rds describe-db-instances --db-instance-identifier ai-workspace-db \
  --query 'DBInstances[0].{class:DBInstanceClass,storage:AllocatedStorage,subnet:DBSubnetGroup.DBSubnetGroupName,sg:VpcSecurityGroups,param:DBParameterGroups}'
aws rds describe-db-snapshots --db-instance-identifier ai-workspace-db \
  --snapshot-type automated --query 'DBSnapshots[].{id:DBSnapshotIdentifier,t:SnapshotCreateTime}'
```

### 2. Take a manual snapshot and start the clock

```bash
STAMP=$(date -u +%Y%m%d-%H%M)
aws rds create-db-snapshot \
  --db-instance-identifier ai-workspace-db \
  --db-snapshot-identifier "drill-$STAMP"
aws rds wait db-snapshot-available --db-snapshot-identifier "drill-$STAMP"
```

Record: snapshot duration.

### 3. Restore into an isolated instance

Restore to a **private** instance with no public access. This is the one place
where the drill must not faithfully reproduce production — do not create a
second internet-reachable database holding real user content.

```bash
aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier "drill-restore-$STAMP" \
  --db-snapshot-identifier "drill-$STAMP" \
  --db-subnet-group-name <same-subnet-group-as-live> \
  --vpc-security-group-ids <restricted-sg-you-control> \
  --no-publicly-accessible \
  --no-multi-az
aws rds wait db-instance-available --db-instance-identifier "drill-restore-$STAMP"
```

Record: restore duration. **This number is the RTO floor.** Everything else in
a real recovery is additive.

### 4. Verify the restored data

From a host inside the VPC (an ECS exec session or a bastion), against the
restored endpoint:

- `\dt` — the expected tables are present.
- `select count(*) from users;` and the same for `chat_threads`,
  `chat_messages`, `audit_log`, `oauth_tokens` — compare against live.
- `select max(created_at) from audit_log;` — how far behind live is the
  restore? **This is the RPO measurement**, and it is the number that matters
  most.
- Spot-check that `oauth_tokens` ciphertext is intact and still decryptable
  with the current `OAUTH_ENCRYPTION_KEY` — a restore that silently breaks
  token decryption is a restore that has not worked.
- Confirm the drizzle migration journal state matches the deployed code's
  expectation.

### 5. Tear down

```bash
aws rds delete-db-instance --db-instance-identifier "drill-restore-$STAMP" \
  --skip-final-snapshot --delete-automated-backups
aws rds delete-db-snapshot --db-snapshot-identifier "drill-$STAMP"
```

**Do not skip this.** A forgotten drill instance is both a recurring cost and a
second unencrypted copy of all user data. Confirm deletion completed.

### 6. Record the result

Append snapshot duration, restore duration, measured RPO, row-count deltas, and
anything that surprised you to this file. If the numbers are worse than the
`docs/ENTERPRISE_READINESS.md` targets, that is a finding — file it.

## What this rehearsal does *not* cover

Stated plainly so nobody reads a successful drill as more than it is:

- **No application cutover.** Repointing `DATABASE_URL` in Secrets Manager,
  restarting ECS tasks, and re-running the authenticated smoke are not
  exercised here. That path is only exercised for real during the #689
  encryption cutover.
- **No point-in-time recovery test.** PITR within the one-day window is a
  different mechanic than snapshot restore.
- **Nothing about the 24-hour retention limit.** The drill proves restore
  works; it does not make the window longer. Raising `BackupRetentionPeriod`
  is a Rob-gated cost decision.
- **No automation.** Every step above is manual. There is no scheduled drill
  and no CI check that this still works.

## Related

- #689 — RDS storage encryption; the cutover reuses steps 2-4 of this drill.
- #697 — no staging environment; a staging instance would be the natural place
  to rehearse the *cutover* half.
- #492 — perimeter epic, including the BCP/DR floor and RPO/RTO targets.
- `docs/security/INCIDENT_RESPONSE.md` — "Database integrity, loss, or
  availability".
