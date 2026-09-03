# Audit surfaces (#456, #458)

The enumeration behind "every mutation audited, lane-independent" and
"cross-user admin reads are attributable." Source of truth for which state
mutations and sensitive reads write an `audit_log` row, where that write lives,
and which are deliberately deferred. Update this file in the same PR as any
change to an audit write.

## Lane-independent by construction (shared core / shared loaders)

These are written in code both execution lanes (interactive SSE and background
worker) share — a new lane inherits them automatically. Parity is pinned by
`apps/web/__tests__/execute-chat-turn.test.ts`.

| Surface | Action type | Written in |
| --- | --- | --- |
| Tool executions (MCP + builtin) | `mcp_tool_execution` | `lib/execute-chat-turn.ts` via `buildToolAuditRows` |
| Denied-provider access | `mcp_tool_attestation` (denied) | `lib/execute-chat-turn.ts` |
| Assistant message persisted | `chat_message_create` | `lib/execute-chat-turn.ts` persist tail |
| Workspace artifact created | `workspace_artifact_create` | `lib/workspace-artifacts.ts` `createArtifactsFromAssistantMessage` |

## Route/lib-level (single-lane surfaces — no fork exists)

Asserted against real Postgres in
`apps/web/__integration__/audit.integration.test.ts` (marked ⚙) or existing
unit suites.

| Surface | Action type(s) | Written in |
| --- | --- | --- |
| User message send ⚙ | `chat_message_create` | `app/api/chat/route.ts` |
| User message edit (destructive tail truncation) | `chat_message_edit` | `app/api/chat/route.ts` |
| Rate-limit denials | `rate_limit` | `app/api/chat/route.ts`, briefing route |
| Shares create/role/revoke | `share_create`, `app_share_*` | `lib/shares.ts` |
| Skills create/update/archive/clone/seed/import | `skill_*` | skill routes + `lib/skills.ts` |
| Schedules create/update ⚙/delete ⚙ | `skill_update`, `schedule_update`, `schedule_delete` | schedule routes |
| Event triggers create/update/delete/fire | `event_trigger_*`, `github_webhook_receive` | trigger routes + `lib/github-event-triggers.ts` |
| Apps register/update/archive/deploy/rollback/drafts/edit sessions | `app_*` | app routes + `lib/apps.ts` |
| Runs cancel/retry/resume | `run_cancel`, `run_retry`, `run_resume` | `lib/run-actions.ts` |
| Admin invitations create/send/revoke/resend/accept | `invite.*` | admin routes + `lib/admin-invitations.ts`, `lib/users.ts` |
| Admin user role change ⚙ | `admin_user_role_update` | `app/api/admin/users/[id]/route.ts` |
| Provider (OAuth) connection lifecycle ⚙ | `connection.granted`, `connection.revoked`, `attestation.granted`, `attestation.revoked` | `lib/oauth/connection.ts`; provider callbacks, the owner-scoped connection route, and the admin connection route all flow through it |
| Connector registry lifecycle | `connector.enabled`, `connector.disabled`, `connector.updated` | `app/api/admin/connectors/[id]/route.ts` |
| Connector tool policy | `connector.tool_policy_updated` | `app/api/admin/connectors/tools/[id]/route.ts` |
| Admin trace access (all inspector reads) | `run_trace_viewed` | admin trace route |

## Authentication

Written from the next-auth config (`lib/auth/nextauth.ts`) through
`lib/auth/auth-audit.ts`; pinned by
`apps/web/__tests__/nextauth-auth-events.test.ts`.

| Surface | Action type | Written in |
| --- | --- | --- |
| Sign-in success | `auth_sign_in` | `lib/auth/nextauth.ts` (`events.signIn`) |
| Sign-in denied by the invite gate — both providers, both magic-link phases | `auth_sign_in_denied` | `lib/auth/nextauth.ts` (`callbacks.signIn`) |
| Sign-out | `auth_sign_out` | `lib/auth/nextauth.ts` (`events.signOut`) |

Rows carry the DB user id (success, sign-out) or the attempted address
(denial, same class of data as `invite.*`), the provider id, and the
ALB-appended client IP plus a truncated user-agent — never tokens.

Two deliberate departures from the surfaces above:

- The auth ledger fails **open**. Cross-user reads fail closed because the
  alternative is unattributable data access; auth failing closed would lock
  every user out of a working app when the ledger is unavailable. A failed
  write logs the error message (never the driver error, which can echo row
  values) and continues.
- Sign-in attempts next-auth rejects *before* the gate runs — expired or
  reused magic-link token, OAuth state mismatch — are not audited. next-auth
  v4 emits no event for them; they surface only as `?error=` on `/login`.

## Cross-user admin data access

Every read below writes `admin_data_access` through
`lib/admin-data-access.ts` when the actor is an admin and the target owner is a
different user. Owner reads and non-admin reads skip the ledger. The receipt
includes the target user, resource type/id, UI or API surface, record count for
collections, and an optional `x-admin-access-justification` header.

`admin_data_access` intentionally means "an admin read another user's data,"
not "the admin role was the only possible authorization path." An admin who
also holds an active app share is still recorded. This conservative definition
keeps the admin-activity trail complete without requiring auditors to
reconstruct historical share state.

Repeated reads by the same actor of the same target/resource/surface are
deduplicated for five minutes. Collection pages collapse rows per target user.
Audit lookup or insert failures fail closed before private data is returned.

| Read surface | Resource receipt | Written in |
| --- | --- | --- |
| Workspace thread list | `chat_thread_collection` / `thread_list` | `app/api/threads/route.ts` |
| Thread detail | `chat_thread` / `thread_detail` | `app/api/threads/[id]/route.ts` |
| Thread messages | `chat_thread` / `thread_messages` | `app/api/threads/[id]/messages/route.ts` |
| Thread export | `chat_thread` / `thread_export` | `app/api/threads/[id]/export/route.ts` |
| Admin run list | `run_collection` / `admin_runs` | `app/admin/runs/page.tsx` |
| Admin run detail | `run` / `admin_run_detail` | `app/admin/runs/[id]/page.tsx` |
| Admin run inspector | `run` / `run_inspector` | `app/api/admin/runs/[id]/trace/route.ts` |
| Background-run status poll | `run` / `run_status` | `app/api/runs/[id]/status/route.ts` |
| Admin feedback list | `feedback_collection` / `admin_feedback` | `app/admin/feedback/page.tsx` |
| Feedback screenshot | `feedback_report` / `feedback_screenshot` | `app/api/admin/feedback/[id]/screenshot/route.ts` |
| App detail API | `app` / `app_api` | `app/api/apps/[id]/route.ts` |
| App data binding | `app` / `app_data` | `app/api/apps/[id]/data/[bindingId]/route.ts` |
| App version list | `app` / `app_versions` | `app/api/apps/[id]/versions/route.ts` |
| App version artifact preview | `workspace_artifact` / `app_version_preview` | `app/api/apps/[id]/versions/[versionId]/content/route.ts` |
| Deployed app artifact | `workspace_artifact` / `deployed_app` | `app/apps/[slug]/route.ts` |
| App management page | `app` / `manage_app` | `app/apps/manage/[id]/page.tsx` |

Run-inspector reads retain the existing `run_trace_viewed` receipt for every
view. Cross-user admin views additionally write `admin_data_access`, so
existing retention/reporting queries remain compatible while the target user
is now attributable.

## Known gap: authentication events (#694)

Not deferred — missing. No authentication event of any kind reaches
`audit_log`: not sign-in, not a sign-in denied by the invite gate, not
sign-out, not session issuance, and not the GitHub-to-existing-user identity
linking that `allowDangerousEmailAccountLinking` permits
(`apps/web/lib/auth/nextauth.ts`). `invite.accept` is the closest existing row
and it fires once per account lifetime.

This is called out separately from the deferred list below because it is not a
low-privilege self-scoped mutation — it is the entry point to everything else,
and "show me failed sign-ins for this user" is a question the ledger cannot
answer. Tracked in #694.

## Deliberately deferred (documented, not yet audited)

Low-privilege or self-scoped mutations; audit rows will ride the surfaces'
next substantive change. Listed so absence reads as a decision, not a gap
discovered by an auditor:

- Thread create/rename/delete (delete's audited variant is planned as an
  admin endpoint — see comment in `app/api/threads/[id]/route.ts`).
- Vault/memory items (user-approved memory writes; self-scoped).
- Notifications (derived state; the triggering mutation is what's audited).
- Recommendations (derived, self-scoped).
- Feedback create / admin feedback triage.
- User profile / custom instructions / preferences.
- Developer-briefing workflow lane: audits tool calls by re-calling
  `buildToolAuditRows` itself — parity by copy, not construction. Folding it
  onto the shared core is tracked in the #453 epic (runner convergence).

## Invariants

- Audit rows carry references (ids), never content bodies or token material.
- `audit_log` rows survive subject/user deletion (actor nulls out) — the
  trail outlives the account.
- New mutation or sensitive-read surfaces must add their row + a test in the
  same PR, and a line here.
