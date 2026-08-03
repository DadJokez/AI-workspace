# RDS network perimeter

The production database predates Comparative's CDK stacks. Its interim network
boundary is therefore enforced by
`infra/scripts/reconcile-rds-perimeter.sh` until #492 adopts the database and
private networking into infrastructure as code.

## Invariant

- RDS instance: `ai-workspace-db`
- RDS setting: `PubliclyAccessible=false`
- Database security group: `sg-019e87b5938a295a4`
- Postgres sources: the CDK-owned web, worker, and one-off deploy-task security
  groups in the application VPC
- The existing database-security-group self reference may remain
- No IPv4 CIDR, IPv6 CIDR, prefix list, or unrecognized security group may
  reach port 5432

The script resolves the three application security groups from CloudFormation
instead of pinning their generated IDs. It checks that RDS has exactly the
reviewed database security group attached and that every allowed source shares
the database VPC.

## Normal deployment

CodeBuild runs `--apply` after reconciling the deploy-task stack and before the
VPC migration task. It runs `--check` again after the authenticated production
smoke. The apply path is idempotent. It can remove the one known historical
`0.0.0.0/0` rule and change `PubliclyAccessible` from true to false; it refuses
to delete any other unexpected rule.

Read-only verification:

```bash
AWS_DEFAULT_REGION=us-east-1 \
  ./infra/scripts/reconcile-rds-perimeter.sh --check
```

## Failure and recovery

An unexpected source is a security finding, not routine drift. Preserve the
command output, inspect the security-group change in CloudTrail, and identify
the owner before changing it. Do not restore `0.0.0.0/0` or make RDS public to
unblock a workstation workflow.

If an application task cannot connect after the perimeter closes:

1. Leave the public path closed.
2. Confirm the task uses the CDK-owned web, worker, or deploy-task security
   group and the default application VPC.
3. Run the migration or authenticated-smoke task inside the VPC to isolate
   credentials from network reachability.
4. Reconcile the owning CDK stack if an expected source rule is missing.
5. Use a reviewed SSM/bastion path for emergency operator access; never add a
   public database CIDR as a temporary workaround.

The first live close and private-path verification is recorded on #690. Future
deploy logs carry migration and smoke receipts that prove the path remains
usable.
