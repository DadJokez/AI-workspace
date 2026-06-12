# Feature Specification: Skills Spine

**Feature Branch**: `002-skills-spine`
**Working Branch**: `spec/002-skills-spine`
**Created**: 2026-06-11
**Status**: Ready for issue tracking
**Input**: User description: "J2, J3, and J4 ready to rock — even if lightweight at first, but with the right bones. People build a skill or an app, share it across the org, and the system eventually proposes skills to you for your role. One spine, three thin journeys."

## Naming decision (binding)

The user-facing primitive is a **Skill** — a saved, shareable agent definition `{system_prompt, mcp_providers, model, params}` that users create, clone, edit, run, schedule, and share. This resolves the open "Recipes vs. Skills" question in PLAN.md. Consequences:

- New table is `skills`, catalog URL is `/skills`, all UI language says "skill".
- The existing `recipe_runs` table is renamed to `runs` in the same migration that creates `skills`. The ledger already records chat turns and workflow runs — neither of which is a recipe — so `runs` is the honest name. Columns `recipe_id`/`recipe_slug` become `skill_id`/`skill_slug`.
- "Recipe" disappears from code, schema, docs, and UI. Done now because the rename is one mechanical migration today and an org-wide language migration later.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Create and Run a Skill (Priority: P1)

A user creates a skill — from scratch at `/skills/new`, or by clicking "Save as skill" on a chat thread that just did something useful — then runs it on demand from the catalog and watches the same streamed activity timeline chat already has.

**Why this priority**: The skill is the spine. Schedules point at skills, shares distribute skills, the future proposal engine recommends skills. Nothing else in this packet exists without this row.

**Independent Test**: Create a skill with a system prompt and the GitHub provider, run it from `/skills`, and confirm a `runs` row with `trigger_type = "skill"`, streamed activity, and redacted tool calls persisted.

**Acceptance Scenarios**:

1. **Given** a signed-in user on `/skills/new`, **When** they save a name, description, system prompt, model tier, and MCP provider list, **Then** a `skills` row is created with them as owner and the skill appears in their catalog.
2. **Given** a chat thread with at least one assistant turn, **When** the user clicks "Save as skill", **Then** a draft skill is pre-filled from the thread's intent and mounted providers, and the user can edit before saving.
3. **Given** a skill the user owns, **When** they click Run, **Then** the skill materializes into an agent definition behind the existing `AgentRuntime` seam, executes through the existing run pipeline, and the run records `skill_id`, route, model, and timing in `runs`.
4. **Given** a skill that declares a provider the user has not connected/attested, **When** they run it, **Then** the run is blocked before any mount with a clear "connect GitHub to run this" message — never a silent failure or hallucinated output.

---

### User Story 2 - Clone and Edit a Starter Skill (Priority: P2)

A colleague who has never spoken to Rob opens the catalog, clones the "Developer Briefing" starter skill, tweaks the prompt to their own repos, and runs it successfully.

**Why this priority**: "A colleague creates their own skill without Rob's help" is the original week-6 ship goal and the first proof that the catalog is self-serve rather than a demo prop.

**Independent Test**: From a second (non-admin) account, clone a starter skill, edit its system prompt, run the clone, and confirm the run executes the edited prompt with `cloned_from_skill_id` recorded.

**Acceptance Scenarios**:

1. **Given** seeded starter skills, **When** any user opens `/skills`, **Then** starters are visible with name, description, required providers, and model tier.
2. **Given** a starter skill, **When** a user clicks Clone, **Then** they get an editable private copy with `cloned_from_skill_id` set, and the starter remains unchanged.
3. **Given** the manual Developer Briefing workflow, **When** starters are seeded, **Then** Developer Briefing exists as a skill row and its runs flow through the same `runs` pipeline as every other skill (the bespoke route may delegate or be retired).

---

### User Story 3 - Schedule a Skill (Priority: P3)

A user schedules a skill — "Developer Briefing, every Monday 8:00 AM America/New_York" — and the result arrives in a designated thread without any user action. This is J3's first breath, and it requires zero new integrations: GitHub MCP is already live.

**Why this priority**: Scheduling is the transition from "chat with tools" to "agents that proactively deliver value," and it is the cheapest thesis demo available (autonomy with already-proven providers).

**Independent Test**: Create a schedule with a near-future fire time, confirm the scheduler enqueues a `runs` row with `trigger_type = "scheduled"`, the existing chat-run worker executes it into the designated thread, and the schedule records `last_run_at`/`next_run_at`.

**Acceptance Scenarios**:

1. **Given** a skill the user can run, **When** they create a schedule (cadence, time, timezone, target thread), **Then** a `schedules` row is created with a computed `next_run_at`.
2. **Given** a due schedule, **When** the scheduler tick claims it (lease semantics, same pattern as chat-run worker), **Then** exactly one queued run is created even with multiple worker instances, and `next_run_at` advances.
3. **Given** a scheduled run whose provider token has expired, **When** it executes, **Then** the run fails with an actionable error and audit row, the schedule stays enabled, and the next occurrence still fires.
4. **Given** a deploy/restart between cadence ticks, **When** services come back, **Then** schedules persist and fire on their next occurrence (no in-memory-only state).
5. **Given** a schedule's history view, **When** the user opens it, **Then** past runs list status, timing, and links to run detail; the user can disable or delete the schedule.

---

### User Story 4 - Share a Skill with a Named Teammate (Priority: P4)

A user shares a skill with a named teammate. It appears in the teammate's catalog under "Shared with you"; they can run it (with their own credentials) or clone it, but not edit the original. This is the J5 seed and the demo's emotional beat: capability moving between people.

**Why this priority**: The create→share→propose flywheel is the product's north star; share is the loop that makes skills an economy instead of a private stash. The mechanism built here (a generic `shares` table) is reused verbatim for apps.

**Independent Test**: Share a skill from account A to account B, sign in as B, run the shared skill with B's own provider tokens, and clone it.

**Acceptance Scenarios**:

1. **Given** a skill the user owns, **When** they share it to a teammate by email/user picker, **Then** a `shares` row (`subject_type = "skill"`) is created and the recipient sees it under "Shared with you".
2. **Given** a shared skill, **When** the recipient runs it, **Then** execution uses the **recipient's** OAuth tokens and attestations — never the owner's — and gates with the same connect/attest messaging as US1.
3. **Given** a shared skill, **When** the recipient clones it, **Then** they get their own editable copy; the original stays read-only to them.
4. **Given** a share, **When** the owner revokes it, **Then** it disappears from the recipient's catalog and their existing clones are unaffected.

---

### User Story 5 - Build and Deploy a Thin App (Priority: P5)

A user asks in chat for a small tool ("make me a dashboard that shows this briefing nicely"), the agent generates a single-page app as a workspace artifact, and the user clicks **Deploy**. The app gets a row in the apps registry, is served behind workspace sign-in at `/apps/{slug}`, appears in the sidebar under **Apps**, and can be shared like a skill. "Save draft" keeps prior versions with plain-English summaries; git, pipelines, and per-app AWS services are explicitly **not** in this slice.

**Why this priority**: J4 is the strongest pure-capability story and the only journey with no buyable equivalent — but its full repo+CI+service shape is an epic. This slice proves the experience (describe → preview → deploy → share) on bones that the full version extends rather than replaces.

**Independent Test**: From chat, generate an HTML artifact app, deploy it, open `/apps/{slug}` from a second signed-in account it was shared with, and confirm an unauthenticated request is redirected to login.

**Acceptance Scenarios**:

1. **Given** a chat-generated artifact marked as an app candidate, **When** the user clicks Deploy, **Then** an `apps` row is created (or updated) pointing at the artifact version, and the app is reachable at `/apps/{slug}` only behind workspace auth.
2. **Given** an unauthenticated request to `/apps/{slug}`, **When** it arrives, **Then** middleware redirects to `/login` exactly as for any workspace page.
3. **Given** further chat iteration on the app, **When** the user clicks "Save draft", **Then** a new artifact version is stored with an agent-written plain-English summary, and Deploy promotes a chosen version to live.
4. **Given** an app's detail view, **When** the user opens Versions, **Then** they see drafts and deployed versions with timestamps and summaries, and can one-click revert to a prior version.
5. **Given** an app, **When** the owner shares it (same `shares` mechanism, `subject_type = "app"`), **Then** recipients see it under Apps and can open it; non-recipients get a 404/forbidden.
6. **Given** generated app content, **When** it is saved or deployed, **Then** credential-shaped strings (token/key/secret patterns) are rejected or redacted by the existing redaction helper — the no-secrets policy applies to app content from day one.

### Edge Cases

- Skill run when `RUNTIME=bedrock` fallback is active: skills must materialize through the seam identically (no Cursor-only assumptions in skill execution).
- Schedule whose owner is deactivated or whose skill is deleted: scheduler must skip gracefully, disable the schedule, and record why.
- Two scheduler instances racing on the same due schedule: lease/claim must guarantee at-most-one enqueue per occurrence.
- Shared skill that declares providers the recipient has never connected: run is gated with a connect prompt; clone is always allowed.
- DST transitions: `next_run_at` computation must be timezone-aware ("8am Monday" stays 8am local across DST).
- App slug collisions and slug squatting: slugs are unique, owner-scoped renames allowed, old slugs 404 (no silent takeover).
- App HTML attempting to call external APIs or load remote scripts: v1 serves with a restrictive CSP; document what is allowed (inline app, same-origin) and what is blocked.
- Concurrent edits to one app: v1 has a single owner-editor (sharing grants use, not edit), so the lock problem from ROADMAP J4 is deferred, not solved silently.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide a `skills` table and CRUD surface for owned skills (create, read, update, archive) with owner-only mutation.
- **FR-002**: System MUST rename `recipe_runs` to `runs` (`recipe_id` → `skill_id`, `recipe_slug` → `skill_slug`) in one migration, with all code references updated in the same change.
- **FR-003**: Skill execution MUST materialize into an agent definition behind the existing `AgentRuntime` seam and reuse the existing run pipeline (`runs`, `run_events`, activity timeline, redaction, audit) — no second execution path.
- **FR-004**: Provider gating MUST be enforced for skill runs exactly as for chat: connection + attestation checked before any MCP mount, with actionable user messaging on denial.
- **FR-005**: System MUST support cloning any visible skill into a private editable copy with provenance (`cloned_from_skill_id`).
- **FR-006**: System MUST seed at least two starter skills, including Developer Briefing as Skill 001, executed through the shared pipeline.
- **FR-007**: System MUST provide a `schedules` table (cadence, time, timezone, target thread, enabled) and a leased scheduler loop that enqueues due runs with `trigger_type = "scheduled"` for the existing worker to execute.
- **FR-008**: Scheduled execution MUST survive deploys/restarts and guarantee at-most-one enqueue per schedule occurrence under concurrent workers.
- **FR-009**: Schedule history MUST be visible per schedule with links into run detail; schedules MUST be disableable and deletable by their owner.
- **FR-010**: System MUST provide a generic `shares` table (`subject_type` ∈ {skill, app}, subject id, granted-to user, granted-by, revocation) used by both skills and apps.
- **FR-011**: Shared-skill execution MUST use the recipient's tokens and attestations; owner credentials MUST never be reachable from a recipient run.
- **FR-012**: System MUST provide an `apps` registry table and serve deployed app artifacts at `/apps/{slug}` behind workspace authentication with a restrictive CSP.
- **FR-013**: Apps MUST support Save draft / Deploy verbs over artifact versions, with agent-written plain-English version summaries and one-click revert.
- **FR-014**: The existing redaction/no-secrets helper MUST be applied to skill definitions and app content at save time (credential-shaped values rejected or redacted).
- **FR-015**: All skill/schedule/share/app mutations MUST write `audit_log` rows (actor, action, subject) consistent with existing audit semantics.
- **FR-016**: Skills MUST declare a logical model tier (existing Haiku/Sonnet/Opus logical ids) that the dispatcher respects per run — author-declared tier is the first routing mode of the orchestration layer.
- **FR-017**: Sidebar MUST gain Skills and Apps sections (Shared-with-you grouping included) without disturbing existing chat history UX.
- **FR-018**: System MUST create focused GitHub issues for the phases in tasks.md, linked back to this packet.

### Key Entities *(include if feature involves data)*

- **Skill**: Saved agent definition — owner, slug, name, description, system prompt, logical model id, MCP provider list, visibility, provenance, starter flag.
- **Run** (renamed from Recipe Run): Existing durable ledger for chat, workflow, skill, and scheduled execution; gains honest naming and `skill_id`/`skill_slug` columns.
- **Schedule**: Cadence definition pointing at a skill — owner, cron-like cadence, timezone, target thread, enabled, last/next fire timestamps, lease fields.
- **Share**: Generic grant — subject type+id, recipient, grantor, created/revoked timestamps. The J5 seed.
- **App**: Registry row — owner, slug, name, description, live artifact version, status (draft/deployed), visibility; versions live in the existing workspace artifacts store.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A non-admin user can go from opening `/skills` to a successful run of a cloned starter skill in under 3 minutes with no assistance.
- **SC-002**: A schedule created for "next Monday 8:00 America/New_York" fires within 5 minutes of target time and delivers into its designated thread, surviving at least one deploy between creation and fire.
- **SC-003**: A shared skill runs under the recipient's credentials — verified by audit rows showing the recipient as actor and the recipient's provider tokens used.
- **SC-004**: A chat-generated app is reachable at `/apps/{slug}` for signed-in recipients and redirects unauthenticated requests to login; version revert restores the prior artifact in one action.
- **SC-005**: The full demo arc (checklists/demo.md) — cross-system question → "every Monday" → "make me an app for this" → share → recipient runs — completes end-to-end on production in under 5 minutes.
- **SC-006**: Zero new execution paths: every skill/scheduled/app-generation run appears in `runs` with route, model, timing, and redacted activity, identical in shape to chat runs.

## Assumptions

- GitHub MCP remains the only live provider during this packet; all five stories are demoable with it alone. New providers (Graph, Workfront) plug into the same bones later.
- The chat-run worker and lease semantics from Runtime V2 are reused for scheduled execution; no new worker service is required (the scheduler tick can live in the existing worker process).
- Workspace artifacts API (live in production) is the storage substrate for app versions; no S3/CloudFront work in this slice — apps are served through `apps/web` behind existing auth middleware.
- The dispatcher work (#110/#105/#106) proceeds in parallel; this packet only requires that skills carry a declared logical model tier for it to respect.
- Batch-priced execution for scheduled runs (50% cost reduction on Bedrock batch) is a follow-up optimization, noted in tasks but not required for v1.
- Sharing is user-to-user only in this packet; org-wide visibility, the opt-in activity feed (#78), and role-based proposal are explicitly downstream of these bones.
