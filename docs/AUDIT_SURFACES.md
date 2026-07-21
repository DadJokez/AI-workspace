# Audit surfaces (#456)

The enumeration behind "every mutation audited, lane-independent". Source of
truth for which state mutations write an `audit_log` row, where that write
lives, and which are deliberately deferred. Update this file in the same PR as
any change to an audit write.

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
| Provider (OAuth) connection ⚙ | `mcp_connection_create` | `lib/oauth/connection.ts` (every callback flows through it) |
| Admin trace access (read) | `run_trace_viewed` | admin trace route |

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
- New mutation surfaces must add their row + a test in the same PR, and a
  line here.
