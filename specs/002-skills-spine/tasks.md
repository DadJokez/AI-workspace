# Tasks: Skills Spine

**Input**: Design documents from `/specs/002-skills-spine/`

**Prerequisites**: [spec.md](./spec.md), [plan.md](./plan.md), [data-model.md](./data-model.md), [checklists/demo.md](./checklists/demo.md)

**Tests**: Every phase lands with vitest coverage (suite is CI-gated as of PR #131), typecheck, and build green. Phase 6 is the production demo-arc smoke.

**Organization**: Phase 1 is the load-bearing foundation (naming + schema). Phases 2–5 map to user stories US1–US5 and are independently shippable Friday demos in themselves. Phase 6 closes the packet against the demo checklist.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files/surfaces).
- **[Story]**: Which user story the task supports.
- File paths relative to repository root.
- GitHub issue links are added next to phases once issues are created.

## Linked GitHub Issues

- [#26 [EPIC] Skills Platform](https://github.com/DadJokez/AI-workspace/issues/26) — supersedes "Recipes Platform" under the binding naming decision
- [#27 [EPIC] Scheduled Agents and Recurring Workflows](https://github.com/DadJokez/AI-workspace/issues/27) — US3 implements its core; SES delivery + event triggers remain there
- J4 thin-slice epic — created with this packet (see PR description)

## Phase 0: Baseline Already Landed

**Purpose**: What exists that this packet builds on — do not rebuild.

- [x] B000 `recipe_runs` ledger with `run_events`, worker leases, retry/resume/cancel (Runtime V2, PRs #92–#113)
- [x] B001 Tool gating: `oauth_tokens` + `user_tool_attestations` checked before MCP mount
- [x] B002 Shared redaction helper applied before chat/tool/run/audit persistence
- [x] B003 Workspace artifacts API live in production (storage substrate for app versions)
- [x] B004 Developer Briefing manual workflow route (becomes Skill 001's behavior)
- [x] B005 Admin runs/audit/tools/usage surfaces

## Phase 1: Naming + Schema Foundation (blocking)

**Purpose**: The one migration everything else stands on. Lands alone, mechanically, compiler-verified.

- [ ] T100 Migration: rename `recipe_runs` → `runs`, `recipe_id` → `skill_id`, `recipe_slug` → `skill_slug`; add `schedule_id` column (`packages/db/drizzle/`)
- [ ] T101 Same migration: create `skills`, `schedules`, `shares`, `apps` per [data-model.md](./data-model.md)
- [ ] T102 Rename Drizzle exports and all code references (`packages/db/src/schema.ts`, `apps/web/**`) in the same commit; typecheck-driven
- [ ] T103 [P] Update docs language Recipes → Skills (`PLAN.md`, `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`, `README.md`)
- [ ] T104 [P] Audit helper: add new `action_type` values (`apps/web/lib/audit.ts` or equivalent)
- [ ] T105 Tests green: full suite + typecheck + build with zero behavior change intended

## Phase 2: US1 + US2 — Create, Run, Clone (J2 tangible)

**Purpose**: The skill exists, runs through the seam, and is self-serve.

- [ ] T200 [US1] `materializeSkill()`: skill row → agent definition consumed by existing turn pipeline (`apps/web/lib/skills/materialize.ts`)
- [ ] T201 [US1] Skills CRUD API with owner-only mutation + audit writes (`apps/web/app/api/skills/...`)
- [ ] T202 [US1] Run-now endpoint: creates `runs` row (`trigger_type="skill"`), executes via existing inline/worker lanes, reuses activity timeline (`apps/web/app/api/skills/[id]/run/route.ts`)
- [ ] T203 [US1] Provider gate on skill runs with actionable connect/attest messaging (reuse `tool-attestations` path)
- [ ] T204 [US1] [P] Catalog UI: `/skills` (mine/starters), `/skills/new`, `/skills/[id]` detail with Run + history (`apps/web/app/skills/...`)
- [ ] T205 [US1] [P] "Save as skill" from a chat thread: prefill from thread intent + mounted providers (`apps/web/lib/skills/save-from-thread.ts`)
- [ ] T206 [US2] Clone endpoint + provenance; starters read-only to non-owners (`apps/web/app/api/skills/[id]/clone/route.ts`)
- [ ] T207 [US2] Seed starters: Developer Briefing as Skill 001 + one more; briefing route delegates to skill execution (`packages/db` seed or admin action)
- [ ] T208 Tests: skills CRUD authz, materialize shape, run gating, clone provenance (`apps/web/__tests__/skills-*.test.ts`)
- [ ] T209 Sidebar: Skills section without disturbing chat history UX (`apps/web/components/...`)

**Checkpoint**: Beat 1 + Beat 3 of [demo.md](./checklists/demo.md) pass on preview.

## Phase 3: US3 — Schedules (J3 first breath)

**Purpose**: The same skill fires without a human, surviving deploys.

- [ ] T300 [US3] DST-safe `next_run_at` module with table-driven tests incl. DST boundaries (`apps/web/lib/schedules/next-run.ts`)
- [ ] T301 [US3] Scheduler tick with lease-claim (at-most-one enqueue per occurrence), hosted in chat-run worker process (`apps/web/lib/schedules/scheduler.ts`, `apps/web/scripts/chat-run-worker.ts`)
- [ ] T302 [US3] Schedules CRUD API + enable/disable + audit (`apps/web/app/api/schedules/...`)
- [ ] T303 [US3] [P] Schedule UI on skill detail: cadence presets, timezone, target thread; history view with run links
- [ ] T304 [US3] Failure semantics: expired-token run fails actionably, schedule persists, `last_error` surfaces
- [ ] T305 Tests: next-run computation, concurrent claim race, occurrence-anchored advancement (`apps/web/__tests__/schedule-*.test.ts`)
- [ ] T306 [P] Follow-up issues filed: SES email delivery (#27), batch-priced scheduled execution (cost: Bedrock batch is 50% — scheduled runs are batch-shaped)

**Checkpoint**: Beat 2 passes on preview, including the deploy-survival rehearsal.

## Phase 4: US4 — Shares (J5 seed)

**Purpose**: Capability moves between people; credentials never do.

- [ ] T400 [US4] Shares API: create/revoke for `subject_type ∈ {skill, app}`, unique active grant, audit (`apps/web/app/api/shares/route.ts`)
- [ ] T401 [US4] Catalog integration: "Shared with you" grouping; shared skills run-with-recipient-credentials and clone-able, never editable
- [ ] T402 [US4] [P] Share UI: user picker on skill/app detail, owner's grants list with revoke
- [ ] T403 Tests: recipient-credential execution (audit actor = recipient), revoke hides subject, clones survive revoke (`apps/web/__tests__/shares-*.test.ts`)

**Checkpoint**: Beat 5 (skill half) passes on preview with two accounts.

## Phase 5: US5 — Apps Thin Slice (J4)

**Purpose**: Describe → preview → deploy → share, on bones the full J4 extends.

- [x] T500 [US5] Apps registry API: register-and-deploy from artifact, deploy/revert (pin version), versions list (`apps/web/app/api/apps/...`). Save draft is implicit: every HTML artifact the source conversation produces is a version candidate.
- [x] T501 [US5] Serve `/apps/{slug}`: route handler streams the owner's live artifact behind workspace auth with restrictive CSP (`default-src 'none'`, inline-only, no egress); unauthenticated → `/login` (`apps/web/app/apps/[slug]/route.ts`)
- [x] T502 [US5] No-secrets policy at save/deploy: `findCredentialShapedContent` blocks GitHub/AWS/API/bearer/JWT/PEM-shaped values with a 422 on register and every deploy (`apps/web/lib/apps.ts`)
- [x] T503 [US5] [P] Apps UI: `/apps` home (list + deploy-from-artifact picker), `/apps/manage/[id]` console (versions deploy/revert, sharing via generalized SharePanel, archive, source-conversation link), Skills↔Apps header cross-links
- [ ] T504 [US5] [P] Chat affordance: artifact marked app-eligible gets a Deploy CTA (reuse artifact pill UX)
- [x] T505 Tests: visibility predicate, no-secrets scanner (positives + clean-content negative), servability, input validation, reserved slugs (`apps/web/__tests__/apps.test.ts`). HTTP-level CSP/serving assertions remain manual via the demo checklist.
- [x] T506 [P] Follow-up tracked on #133: full J4 (repo/pipeline/per-app-service, edit locking, app SSO tokens) stays open there; this packet ships the thin slice

**Checkpoint**: Beat 4 + Beat 5 (app half) pass on preview.

## Phase 6: Production Close-Out

**Purpose**: The packet's definition of done.

- [ ] T600 Run the full [demo arc](./checklists/demo.md) on production with two accounts; check every box
- [ ] T601 Capture evidence: recording, audit export, `runs` rows (IT-review dossier inputs)
- [ ] T602 Update PLAN.md current-state table and ROADMAP journey statuses (J2 🔄→✅ thin, J3 ⏳→🔄, J4 ⏳→🔄 thin, J5 seed noted)
- [ ] T603 File follow-up issues discovered during close-out; link them here

## Dependencies

- Phase 1 blocks everything (schema + naming).
- Phase 2 blocks 3, 4, 5 (skills must exist to schedule/share; apps reuse the share mechanism from 4 — T400 can land with Phase 4 or be pulled earlier if Phase 5 starts first).
- Phases 3, 4, 5 are mutually independent after Phase 2 — each is a standalone Friday demo.
- Phase 6 requires all checkpoints.
