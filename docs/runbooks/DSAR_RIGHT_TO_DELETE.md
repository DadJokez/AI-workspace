# Runbook: DSAR / right-to-delete (manual procedure)

**Status: written, never executed. Almost none of it is automated.**

This runbook exists so that a data-subject access or deletion request has a
documented answer today, rather than being improvised under a deadline. Read
the "What is not automated" section first — it is most of the runbook, and
pretending otherwise would be the exact kind of doc/code drift this file is
meant to prevent.

**Policy is not engineering's to invent.**
[#460](https://github.com/DadJokez/AI-workspace/issues/460) owns approved
retention windows, hard deletion, legal hold, and deprovisioning. Until #460
lands, every execution of this runbook needs an explicit, recorded
privacy/legal approval. This document describes *how*, never *whether*.

## Before touching anything

1. **Record the request**: who is asking, for whom, what they are asking for
   (access, export, correction, deletion), the date, and the legal basis
   claimed.
2. **Verify identity.** The requester must be provably the subject or their
   authorized representative. There is no self-service identity-verification
   flow; this is a human judgment, and it is the step that prevents this
   runbook from becoming an account-takeover tool.
3. **Check for legal hold.** There is no legal-hold mechanism in the product
   (#460). If a hold might apply, stop and escalate — a deletion performed here
   is not reversible from the application.
4. **Get written approval** from the privacy/legal owner, and from Rob for any
   production database write.

## What data exists for a user

From `docs/security/DATA_FLOW_AND_CLASSIFICATION.md` and
`packages/db/src/schema.ts`. Everything below is keyed to `users.id` directly
or through a cascade:

| Area | Tables |
|---|---|
| Identity and preferences | `users` |
| Chat | `chat_threads`, `chat_messages` |
| Memory | `user_memory_items`, `memory_capture_queue` |
| Artifacts and apps | `workspace_artifacts`, `apps`, `app_versions`, `app_edit_sessions` |
| Skills, schedules, triggers | `skills`, `schedules`, `event_triggers`, `event_trigger_deliveries` |
| Runs | `runs`, `run_events` |
| Provider credentials | `oauth_tokens` (AES-256-GCM ciphertext) |
| Tool consent | `user_tool_attestations`, `mcp_servers` |
| Sharing | `shares` |
| Product surface | `notifications`, `recommendations`, `feedback_reports` |
| Auth material | `verification_tokens`, `invitations` |
| Ledger | `audit_log` (see the deletion caveat below) |

Outside Postgres: CloudWatch application logs (30-day retention, redacted but
may contain identifiers), PostHog Cloud (stable user ID and role, sanitized
route templates, bounded properties — no content), and any provider-side data
at GitHub/Google/Notion/Salesforce, which Comparative does not control.

## Access / export request

There is **no user-data export endpoint**. The product has a per-thread export
(`GET /api/threads/[id]/export`) and nothing else.

The current procedure is manual, read-only SQL against production, assembled by
hand:

1. Resolve the subject: `select id, email, role, created_at from users where email = $1;`
2. Query each table in the inventory above by `user_id` (or via the owning
   thread/run for cascaded tables).
3. **Redact other people's data before delivering anything.** A thread the
   subject participated in may reference shared apps, other users' skills, or
   provider records belonging to a third party. This is the step most likely to
   turn one DSAR into a second incident.
4. **Never include `oauth_tokens` ciphertext, `verification_tokens` hashes, or
   invite tokens** in an export. They are `Restricted` credential material, not
   subject data, and exporting them creates a live credential in an email
   attachment.
5. Deliver through an approved channel; record what was sent and when.

Every cross-owner read an admin performs while assembling this writes an
`admin_data_access` receipt (`docs/AUDIT_SURFACES.md`) — that is correct and
expected. Direct SQL does not, which is why the operator must record the
actions manually.

## Deletion request

There is **no user-deletion endpoint and no deletion script.** The admin API
exposes only `GET /api/admin/users` and `PATCH /api/admin/users/[id]` (role
change). Deletion is manual SQL, and it is irreversible.

### Order of operations

1. **Confirm approval and absence of legal hold.** Again, in writing.
2. **Revoke provider access first.** Delete the subject's `oauth_tokens` rows
   and — because there is no in-product disconnect (#692) — tell the subject to
   revoke Comparative at each provider (GitHub, Google, Notion, Salesforce)
   themselves. Deleting the row removes Comparative's copy; it does not revoke
   the grant at the provider.
3. **Take a snapshot** of `ai-workspace-db` before the delete. This is your
   only undo, and automated backups retain **one day**
   (`docs/runbooks/DB_RESTORE_REHEARSAL.md`).
4. **Delete the `users` row inside a transaction.** Foreign keys do the rest:
   most user-owned tables are `ON DELETE CASCADE`, and `audit_log.actor_user_id`
   is `ON DELETE SET NULL`.

```sql
BEGIN;
-- verify the blast radius before committing
SELECT count(*) FROM chat_threads WHERE user_id = :id;
SELECT count(*) FROM runs WHERE user_id = :id;
SELECT count(*) FROM workspace_artifacts WHERE user_id = :id;
DELETE FROM users WHERE id = :id;
-- inspect, then COMMIT or ROLLBACK
COMMIT;
```

5. **Verify.** Re-run the inventory queries; confirm zero rows. Confirm
   `audit_log` rows survive with `actor_user_id` null.
6. **Record** what was deleted, when, by whom, under which approval, and the
   snapshot identifier.

### The audit-ledger caveat — say this to the requester

`audit_log` rows are deliberately **retained** after deletion, with the actor
nulled out (`docs/AUDIT_SURFACES.md`: "the trail outlives the account"). The
rows keep references — ids, provider and tool names, redacted payloads — not
content bodies or token material.

This is a real tension between the security requirement (an audit trail that
cannot be erased by deleting an account) and a deletion request. **Do not
quietly resolve it in either direction.** Surface it to privacy/legal and
record the decision. If they require the audit rows purged too, that is a
policy decision with a security consequence, and it belongs in #460 and #457
rather than in an ad-hoc `DELETE`.

## What is not automated

Stated explicitly, because a reviewer will ask and a vague answer is worse than
an honest one:

- **No user-deletion endpoint or script.** Manual SQL only.
- **No user-data export.** Only per-thread export exists.
- **No identity verification flow** for a data-subject request.
- **No legal hold** mechanism (#460).
- **No deprovisioning hook.** Removing someone from an IdP does nothing here;
  enterprise IdP/SCIM is not live (#491).
- **No OAuth disconnect** in the product (#692) — provider revocation is the
  subject's own action.
- **No cascade to CloudWatch or PostHog.** Log-group retention expires the data
  on its own 30-day schedule; PostHog deletion is a separate manual request
  through PostHog. Neither is triggered by the database delete.
- **No retention windows.** Nothing expires on a policy today (#460).
- **No test coverage** for any of the above, because none of it is code.

## Related

- #460 — data lifecycle: retention, right-to-delete, deprovisioning. The issue
  that makes most of this runbook obsolete when it lands.
- #692 — OAuth disconnect route.
- #694 — authentication events are not audited, so "when did this account last
  sign in" cannot be answered from the ledger.
- #457 — tamper-evident audit log (interacts with the deletion caveat above).
- `docs/security/DATA_FLOW_AND_CLASSIFICATION.md` — the authoritative data
  inventory this runbook indexes.
