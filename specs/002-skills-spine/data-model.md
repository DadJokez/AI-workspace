# Data Model: Skills Spine

**Input**: [spec.md](./spec.md) · [plan.md](./plan.md)

One migration delivers everything below: the `runs` rename plus four new tables. All ids are uuids, all tables get `created_at`/`updated_at` timestamps, all FKs cascade-restrict consistent with existing schema conventions in `packages/db/src/schema.ts`.

## 1. Rename: `recipe_runs` → `runs`

The ledger already records chat turns and workflow runs; after this packet it also records skill and scheduled runs. `runs` is the honest name.

| Change | Detail |
|---|---|
| Table | `recipe_runs` → `runs` (`ALTER TABLE ... RENAME` — metadata-only, instant) |
| Column | `recipe_id` → `skill_id` (uuid, nullable, FK → `skills.id` added once `skills` exists) |
| Column | `recipe_slug` → `skill_slug` (text, nullable) |
| Column | `trigger_type` gains values: existing (`chat`, `workflow`, `manual`) plus `skill`, `scheduled` |
| Column (new) | `schedule_id` uuid nullable FK → `schedules.id` — which schedule occurrence produced this run |
| Code | Drizzle export `recipeRuns` → `runs`; compiler-driven rename across `apps/web` and packages; tests/docs updated in the same commit |

Existing rows keep their data; no backfill required.

## 2. New table: `skills`

The user-facing primitive. A saved agent definition.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `slug` | text unique | URL-safe, generated from name, owner-scoped uniqueness is NOT enough — global unique for shareability |
| `name` | text | |
| `description` | text | Shown in catalog and (later) proposal surfaces |
| `owner_user_id` | uuid FK → users | Only the owner mutates |
| `system_prompt` | text | The agent definition core |
| `model_id` | text | Logical tier (`haiku`/`sonnet`/`opus` logical ids) — dispatcher input, FR-016 |
| `mcp_providers` | jsonb | Array of provider slugs (e.g. `["github"]`); mount still gated per-run by executing user's tokens + attestations |
| `params_schema` | jsonb nullable | **Deferred** — column reserved, unused in v1 |
| `visibility` | text enum: `private` | v1 single value; `org` reserved for post-packet |
| `cloned_from_skill_id` | uuid nullable FK → skills | Provenance for the clone graph (future proposal signal) |
| `is_starter` | boolean default false | Admin-seeded starters (Developer Briefing = Skill 001) |
| `archived_at` | timestamp nullable | Soft delete; archived skills stop appearing/running but history persists |

Indexes: `owner_user_id`, `is_starter`, `slug`.

## 3. New table: `schedules`

A cadence pointing at a skill.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK → users | Runs execute as this user, with their tokens |
| `skill_id` | uuid FK → skills | |
| `cadence` | text | v1 constrained set expressed as cron string (`0 8 * * MON`); UI offers daily/weekdays/weekly/monthly presets |
| `timezone` | text | IANA zone; `next_run_at` computed DST-safely in `lib/schedules/next-run.ts` |
| `target_thread_id` | uuid nullable FK → chat_threads | Where output lands; null = create dedicated thread on first fire and persist it here |
| `enabled` | boolean default true | |
| `last_run_at` | timestamp nullable | |
| `next_run_at` | timestamp | Indexed — scheduler scans `enabled AND next_run_at <= now()` |
| `claimed_at` / `claimed_by` | timestamp / text, nullable | Lease fields, same semantics as chat-run worker claims; guarantee at-most-one enqueue per occurrence |
| `last_error` | text nullable | Most recent failure summary for the schedule list UI |

Indexes: `(enabled, next_run_at)`, `user_id`, `skill_id`.

Scheduler contract: claim due row (lease) → insert queued `runs` row (`trigger_type='scheduled'`, `skill_id`, `schedule_id`, `thread_id`) → advance `next_run_at` from the **scheduled** occurrence time (not claim time, so delayed ticks don't drift) → release lease. Worker execution, retry, and cancel are the existing run machinery untouched.

## 4. New table: `shares`

Generic grant — the J5 seed, shared by skills and apps.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `subject_type` | text enum: `skill`, `app` | |
| `subject_id` | uuid | FK enforced in application layer (polymorphic); composite index with type |
| `granted_to_user_id` | uuid FK → users | |
| `granted_by_user_id` | uuid FK → users | |
| `revoked_at` | timestamp nullable | Revocation hides the subject; recipient clones are unaffected |

Unique: `(subject_type, subject_id, granted_to_user_id)` where `revoked_at IS NULL`.

Semantics: a share grants **visibility + run/open + clone** — never edit, never the grantor's credentials. Every run re-gates on the recipient's own `oauth_tokens` and `user_tool_attestations`.

## 5. New table: `apps`

Registry for deployed thin apps; versions live in the existing workspace artifacts store.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `slug` | text unique | Serves at `/apps/{slug}`; renames release the old slug to 404 (no reuse window in v1) |
| `name` / `description` | text | |
| `owner_user_id` | uuid FK → users | Single editor in v1; shares grant open-only |
| `live_artifact_id` | uuid nullable | FK → workspace artifact version currently deployed; null = draft-only |
| `status` | text enum: `draft`, `deployed` | |
| `source_thread_id` | uuid nullable FK → chat_threads | Where it was built — "open the conversation behind this app" |
| `archived_at` | timestamp nullable | |

Version history = the artifact store's versions for this app, each carrying an agent-written plain-English summary (stored in artifact metadata, not a new table). Save draft = new artifact version; Deploy = repoint `live_artifact_id`; revert = repoint to an older version.

## Audit events (FR-015)

New `audit_log.action_type` values, written through the existing helper with existing redaction: `skill.create|update|clone|archive|run`, `schedule.create|update|disable|delete|fire`, `share.create|revoke`, `app.register|deploy|save_draft|revert|archive`.

## Explicitly deferred

`params_schema` execution, org-wide visibility, share-by-link, event triggers, batch-priced scheduled runs, app edit-locking (single-editor v1 makes it moot), activity-feed projections (#78), proposal/recommendation signals — all build on these rows without schema breaks.
