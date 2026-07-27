# Runbooks

Operational procedures for Comparative production. Each runbook states what is
automated and what is not; where a step is manual, it says so rather than
implying a tool exists.

Nothing here has been rehearsed against production unless the runbook says it
has. A written procedure is not a drill — the point of writing them is that the
first execution should not also be the first draft.

| Runbook | Purpose | Rehearsed? |
|---|---|---|
| [DB_RESTORE_REHEARSAL.md](./DB_RESTORE_REHEARSAL.md) | Restore `ai-workspace-db` from a snapshot into an isolated instance and verify it | **No** |
| [AGENTCORE_ROLLBACK.md](./AGENTCORE_ROLLBACK.md) | Roll the Bedrock AgentCore runtime back to a previously deployed image | **No** |
| [DSAR_RIGHT_TO_DELETE.md](./DSAR_RIGHT_TO_DELETE.md) | Answer a data-subject access or deletion request | **No** |

Related:

- [Production deployment](../PRODUCTION_DEPLOYMENT.md) — the deploy path, ECS
  rollback (`infra/scripts/rollback-ecs.sh`), and deployment receipts.
- [Incident response](../security/INCIDENT_RESPONSE.md) — severity, evidence
  handling, containment, and recovery.
- [Data flow and classification](../security/DATA_FLOW_AND_CLASSIFICATION.md) —
  what data lives where, which the DSAR runbook depends on.
