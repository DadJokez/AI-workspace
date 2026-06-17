# Tasks: Runtime V2 Autopilot

**Input**: Design documents from `/specs/001-runtime-v2-autopilot/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/api-chat-runtime-v2.md](./contracts/api-chat-runtime-v2.md)

**Tests**: Include targeted unit/type/build checks and production smoke because Runtime V2 changes user-facing latency and routing behavior.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel because it touches different files or operational surfaces.
- **[Story]**: Which user story the task supports.
- File paths are relative to repository root.
- GitHub issue links are added next to task groups once issues are created.

## Linked GitHub Issues

- [#103 Runtime V2 production rollout and App Runner retirement](https://github.com/DadJokez/AI-workspace/issues/103)
- [#104 Polish Runtime V2 autopilot router and tool escalation](https://github.com/DadJokez/AI-workspace/issues/104)
- [#105 Add direct-chat model fallback and provider-access diagnostics](https://github.com/DadJokez/AI-workspace/issues/105)
- [#106 Add Runtime V2 latency and failure reporting](https://github.com/DadJokez/AI-workspace/issues/106)
- [#107 Move chat rate limiting to shared storage before ECS web scale-out](https://github.com/DadJokez/AI-workspace/issues/107)
- [#89 Introduce durable background runs for long agent work](https://github.com/DadJokez/AI-workspace/issues/89)

## Phase 0: Baseline Already Landed

**Purpose**: Record what PR #102 already delivered so future work does not duplicate it.

- [x] T000 [P] Document Runtime V2 Autopilot baseline in `docs/RUNTIME_V2_AUTOPILOT_SPEC.md`.
- [x] T001 [P] Implement deterministic route selection in `apps/web/lib/chat-routing.ts`.
- [x] T002 [P] Add direct-chat inline runner path in `apps/web/lib/chat-inline-runner.ts`.
- [x] T003 [P] Store route/runtime/model metadata in `recipe_runs.inputs` and `recipe_runs.outputs`.
- [x] T004 [P] Record first-token and completion metrics in run outputs.
- [x] T005 [P] Surface first-token metrics in `apps/web/app/admin/runs/page.tsx` and `apps/web/app/admin/runs/[id]/page.tsx`.
- [x] T006 [P] Add Runtime V2 preview stack in `infra/cdk/lib/ai-workspace-runtime-v2-preview-stack.ts`.
- [x] T007 [P] Deploy Runtime V2 preview services and validate `/api/health`.

---

## Phase 1: Spec Kit Conversion (Shared Tracking)

**Purpose**: Make Runtime V2 traceable as a Spec Kit feature packet and GitHub issue set.

- [x] T008 [P] Create `specs/001-runtime-v2-autopilot/spec.md`.
- [x] T009 [P] Create `specs/001-runtime-v2-autopilot/plan.md`.
- [x] T010 [P] Create `specs/001-runtime-v2-autopilot/research.md`.
- [x] T011 [P] Create `specs/001-runtime-v2-autopilot/data-model.md`.
- [x] T012 [P] Create `specs/001-runtime-v2-autopilot/contracts/api-chat-runtime-v2.md`.
- [x] T013 [P] Create `specs/001-runtime-v2-autopilot/checklists/rollout.md`.
- [x] T014 [P] Create `specs/001-runtime-v2-autopilot/quickstart.md`.
- [x] T015 [P] Create focused GitHub issues for remaining Runtime V2 work and link them from this file.
- [x] T016 [P] Add references from existing Runtime V2 docs to the Spec Kit packet.

**Checkpoint**: Runtime V2 has one canonical execution packet plus linked GitHub issues.

---

## Phase 2: User Story 1 - Fast Ordinary Chat (Priority: P1) MVP

**Goal**: Production ordinary chat uses fast-local direct streaming with measurable first-token latency.

**Independent Test**: Send `say pong and nothing else`; verify inline streaming, `fast-local`, `direct-chat`, and metrics.

**GitHub Issue**: [#103](https://github.com/DadJokez/AI-workspace/issues/103)

### Tests for User Story 1

- [x] T017 [P] [US1] Extend `apps/web/__tests__/chat-routing.test.ts` to assert fast-local production flag behavior and route reason.
- [x] T018 [P] [US1] Add a focused test around metrics population in `apps/web/lib/chat-inline-runner.ts` or the nearest existing test seam.

### Implementation for User Story 1

- [ ] T019 [US1] Validate preview fast-local route through `specs/001-runtime-v2-autopilot/checklists/rollout.md`.
- [ ] T020 [US1] Compare Runtime V2 fast-local first-token latency against old Cursor-agent fast chat using `/admin/runs`.
- [ ] T021 [US1] Enable Runtime V2 on production web only after preview smoke passes.
- [ ] T022 [US1] Record production smoke evidence in the GitHub issue.

**Checkpoint**: Fast ordinary chat is production-default and measured.

---

## Phase 3: User Story 2 - Automatic Tool Escalation (Priority: P2)

**Goal**: GitHub/tool prompts automatically route to the local Bedrock agent path with narrow MCP mounting.

**Independent Test**: Ask for recent GitHub PRs and verify `tool-local`, GitHub MCP activity, persisted tool calls/results, and audit rows.

**GitHub Issue**: [#104](https://github.com/DadJokez/AI-workspace/issues/104)

### Tests for User Story 2

- [x] T023 [P] [US2] Add routing tests for more natural GitHub phrasing in `apps/web/__tests__/chat-routing.test.ts`.
- [x] T024 [P] [US2] Add/extend tests for denied provider approval messaging where existing seams allow it.

### Implementation for User Story 2

- [x] T025 [US2] Improve router reasons in `apps/web/lib/chat-routing.ts` so admin/debug views can explain tool escalation.
- [x] T026 [US2] Verify tool-local inline streaming and activity replay in `apps/web/lib/chat-inline-runner.ts`.
- [ ] T027 [US2] Smoke GitHub "last three PRs" in preview and production.
- [x] T028 [US2] Document any false positives/false negatives and decide whether a lightweight classifier is warranted.

**Checkpoint**: Tool prompts feel automatic without slowing simple chat.

---

## Phase 4: User Story 3 - Durable Work Escalation (Priority: P3)

**Goal**: Long-running implementation/test/deploy prompts route to durable worker without affecting simple chat.

**Independent Test**: Send an implementation prompt and verify queued run, worker claim, persisted activity, refresh recovery, and retry/resume preservation.

**GitHub Issue**: [#89](https://github.com/DadJokez/AI-workspace/issues/89)

### Tests for User Story 3

- [ ] T029 [P] [US3] Add routing tests for implementation/test/deploy/migration prompts in `apps/web/__tests__/chat-routing.test.ts`.
- [ ] T030 [P] [US3] Extend retry/resume tests to assert runtime route and execution mode preservation.

### Implementation for User Story 3

- [ ] T031 [US3] Smoke durable-local worker claim in preview and production.
- [ ] T032 [US3] Verify cancel/retry/resume run actions preserve route and execution mode in `apps/web/lib/run-actions.ts`.
- [ ] T033 [US3] Update stale long-run GitHub tracking to reflect the shipped worker baseline and remaining durable Runtime V2 gaps.

**Checkpoint**: Long work is durable, reloadable, and does not leak into fast-local chat.

---

## Phase 5: User Story 4 - Explicit Cloud Escape Hatch (Priority: P4)

**Goal**: Cursor Cloud remains explicit, one-shot, and recoverable.

**Independent Test**: Toggle Cloud for one send and verify `cursor-cloud`; send again and verify local default.

**GitHub Issue**: [#103](https://github.com/DadJokez/AI-workspace/issues/103)

### Tests for User Story 4

- [ ] T034 [P] [US4] Extend `apps/web/__tests__/chat-execution-mode.test.ts` for one-shot cloud reset behavior where testable.
- [ ] T035 [P] [US4] Extend retry/resume tests to assert cloud mode is preserved for cloud runs.

### Implementation for User Story 4

- [ ] T036 [US4] Smoke explicit Cloud in preview and production.
- [ ] T037 [US4] Verify cloud cancellation still calls Cursor Cloud when provider run metadata exists.
- [ ] T038 [US4] Make the Cloud control visually secondary to avoid implying it is the default mode.

**Checkpoint**: Cloud is available but never accidental.

---

## Phase 6: User Story 5 - Safe Model Fallback (Priority: P5)

**Goal**: Denied provider model access does not create a confusing default experience.

**Independent Test**: Configure/select a denied direct model and verify fallback or clear user/admin error.

**GitHub Issue**: [#105](https://github.com/DadJokez/AI-workspace/issues/105)

### Tests for User Story 5

- [ ] T039 [P] [US5] Add model mapping/fallback tests near `packages/agent/src/models.ts` or the direct runtime model selection seam.
- [ ] T040 [P] [US5] Add an error normalization test for provider model-access denial.

### Implementation for User Story 5

- [ ] T041 [US5] Audit direct-runtime model mapping in `apps/web/lib/chat-inline-runner.ts` and `packages/agent/src/models.ts`.
- [ ] T042 [US5] Prefer configured allowed direct model for Bedrock fast-local turns.
- [ ] T043 [US5] Surface clear user/admin diagnostics for AWS Marketplace/model access denial.
- [ ] T044 [US5] Smoke the app with the current production default model and direct model config.

**Checkpoint**: Runtime V2 does not fail ordinary chat because of a denied model default.

---

## Phase 7: Measurement And Scale Hardening

**Purpose**: Make Runtime V2 measurable and safe to scale beyond one web task.

**GitHub Issues**: [#106](https://github.com/DadJokez/AI-workspace/issues/106), [#107](https://github.com/DadJokez/AI-workspace/issues/107), [#103](https://github.com/DadJokez/AI-workspace/issues/103)

- [ ] T045 [P] Add a lightweight latency dashboard/query path for first-token p50/p95 by lane.
- [ ] T046 [P] Group failed runs by lane, runtime target, provider, and model error class.
- [x] T047 Done 2026-06-13: Move process-local chat rate limiting to shared Postgres `rate_limit_buckets` storage before scaling web beyond one task.
- [x] T048 Document App Runner rollback retirement criteria for Runtime V2 production observation.
- [ ] T049 Update `PLAN.md` and `docs/ROADMAP.md` after production Runtime V2 rollout.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 0**: Already landed in PR #102.
- **Phase 1**: Can complete immediately and creates tracking visibility.
- **Phase 2**: Highest priority; production speed depends on it.
- **Phase 3**: Can proceed in parallel with Phase 2 smoke but should not block fast-local rollout unless GitHub smoke fails badly.
- **Phase 4**: Depends on existing worker path and retry/resume controls.
- **Phase 5**: Can proceed in parallel with Phases 2-4.
- **Phase 6**: Should happen before broad production enablement if model access errors reproduce.
- **Phase 7**: Starts after enough run metrics exist.

### User Story Dependencies

- **US1 Fast Ordinary Chat**: No dependency beyond baseline and preview health.
- **US2 Automatic Tool Escalation**: Depends on existing GitHub OAuth/MCP and attestation gates.
- **US3 Durable Work Escalation**: Depends on existing chat-worker service and `recipe_runs` leases.
- **US4 Explicit Cloud Escape Hatch**: Depends on Cursor Cloud secrets/provider metadata.
- **US5 Safe Model Fallback**: Depends on direct runtime model mapping and observed provider access behavior.

### Parallel Opportunities

- GitHub issue creation, docs references, and checklist updates can run in parallel.
- Router tests can run in parallel with model fallback work.
- Metrics/dashboard issue can be worked independently after run outputs are populated.
- Shared rate limiting is independent but must land before ECS web scale-out.

## Implementation Strategy

### MVP First

1. Complete Phase 1.
2. Complete Phase 2 production rollout.
3. Validate fast-local simple chat with first-token metrics.
4. Stop and compare the experience before adding a classifier.

### Incremental Delivery

1. Fast-local production default.
2. Tool-local router polish.
3. Durable/cloud smoke and preservation checks.
4. Model fallback.
5. Metrics and shared-rate-limit hardening.

## Notes

- Do not add a user-facing "agent mode" toggle.
- Do not default to Cursor Cloud for normal chat.
- Do not mount every connected MCP provider on every turn.
- Treat model access errors as product failures, not user mistakes.
