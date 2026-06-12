# Implementation Plan: Skills Spine

**Branch**: `spec/002-skills-spine` | **Date**: 2026-06-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-skills-spine/spec.md`

## Summary

One spine carries three journeys. A **skill** (saved agent definition) is created, cloned, and run (J2 made tangible); a **schedule** fires the same skill through the same worker on a cadence (J3); an **app** is a deployed artifact with a registry row and the same share mechanism (J4 thin slice + J5 seed). Every execution flows through the existing `AgentRuntime` seam into the existing run ledger — this packet adds definition, trigger, and distribution layers around machinery that already works. The strategic target is the 5-minute demo arc in [checklists/demo.md](./checklists/demo.md): the create→share→(future)propose flywheel shown end-to-end on production with only the GitHub provider.

## Technical Context

**Language/Version**: TypeScript on Node 20

**Primary Dependencies**: Next.js 15, NextAuth v4, Drizzle, `@cursor/sdk`, AWS Bedrock Runtime SDK, AWS CDK TypeScript, pnpm workspaces

**Storage**: RDS Postgres through `packages/db` Drizzle schema. This packet **renames** `recipe_runs` → `runs` and **adds** `skills`, `schedules`, `shares`, `apps`. It reuses `run_events`, `chat_messages`, `audit_log`, `oauth_tokens`, `user_tool_attestations`, `mcp_servers`, and the workspace artifacts store unchanged.

**Testing**: Vitest through `pnpm --filter @ai-workspace/web test` (now gated in CI per PR #131), TypeScript checks, Next build, CDK synth unchanged, production demo-arc smoke per checklist

**Target Platform**: Existing AWS ECS/Fargate web + chat-worker + memory-worker services; scheduler tick hosts inside the chat-worker process (no new service)

**Project Type**: Monorepo web app plus runtime packages and CDK infrastructure

**Performance Goals**: Skill run-now feels identical to chat (same lanes/dispatcher); scheduled runs fire within 5 minutes of target; catalog and app pages are ordinary Next.js pages with no new latency-sensitive paths

**Constraints**: No second execution path; no new worker service; no git/CI/per-app-AWS provisioning in the J4 slice; sharing is run/clone-grant, never credential delegation; all new mutations audited; naming is Skills everywhere user-facing

**Scale/Scope**: Pilot-scale on current infrastructure. Bones must not preclude the 100k path: schedules use lease-claim (multi-instance safe), shares/apps are plain relational rows, scheduler throughput scales by worker count.

## Constitution Check

- **Single runtime seam**: PASS. Skills materialize into agent definitions consumed by `getRuntime().runTurn()`; scheduled runs enqueue into the same worker; app generation is a chat turn. Zero code paths branch on runtime above the seam.
- **MCP is the integration pattern**: PASS. Skills declare provider slugs; mounting stays inside the existing per-turn gate. No skill-side tool shims.
- **Permissions first-class**: PASS. Every run — owned, cloned, shared, scheduled — re-checks the *executing* user's connections and attestations at mount time. Shares grant visibility, never credentials.
- **Thin enterprise wrapper**: PASS. The packet builds definition/trigger/distribution/governance layers; the agent harness, models, and integrations stay rented.
- **Defer abstractions**: PASS with two deliberate exceptions, each justified by a named second use case already in hand: the generic `shares` table (skills *and* apps need it in this packet) and the `runs` rename (chat *and* workflow rows already prove `recipe_runs` is a misnomer). Deferred: params schemas on skills, org-wide visibility, event triggers, the activity feed (#78), batch-priced scheduled execution, full J4 (repo/pipeline/service).

## Project Structure

### Documentation (this feature)

```text
specs/002-skills-spine/
├── spec.md
├── plan.md
├── data-model.md
├── checklists/
│   └── demo.md
└── tasks.md
```

### Source Code (repository root)

```text
packages/db/
├── src/schema.ts                      # rename recipeRuns → runs; add skills, schedules, shares, apps
└── drizzle/                           # one migration: rename + 4 new tables

apps/web/
├── app/skills/page.tsx                # catalog: mine / starters / shared-with-you
├── app/skills/new/page.tsx            # create form
├── app/skills/[id]/page.tsx           # detail: run, edit, clone, share, schedule, history
├── app/apps/page.tsx                  # apps list (sidebar section)
├── app/apps/[slug]/page.tsx           # serve deployed artifact behind auth + CSP
├── app/api/skills/route.ts            # list/create
├── app/api/skills/[id]/route.ts       # get/update/archive
├── app/api/skills/[id]/run/route.ts   # run-now → existing run pipeline
├── app/api/skills/[id]/clone/route.ts
├── app/api/schedules/route.ts         # + [id] routes: CRUD, enable/disable
├── app/api/shares/route.ts            # create/revoke for skill|app subjects
├── app/api/apps/route.ts              # + [id]: register, deploy, save-draft, revert
├── lib/skills/materialize.ts          # skill row → agent definition (seam input)
├── lib/skills/save-from-thread.ts     # "Save as skill" prefill
├── lib/schedules/next-run.ts          # timezone-aware next_run_at (DST-safe)
├── lib/schedules/scheduler.ts         # leased tick: due schedules → queued runs
├── scripts/chat-run-worker.ts         # hosts scheduler tick alongside run claims
└── __tests__/                         # skills-crud, skill-run-gating, schedule-next-run,
                                       # scheduler-claim, shares-access, apps-serving tests
```

## Execution Flow (per layer)

1. **Definition**: `skills` row → `materializeSkill()` → `{systemPrompt, mcpProviders, modelId}` → existing turn-context builder → `AgentRuntime`.
2. **Trigger**: scheduler tick (inside chat-run worker loop) claims due `schedules` rows with the existing lease pattern → inserts queued `runs` row (`trigger_type='scheduled'`, target thread) → existing worker executes it exactly like a durable chat run.
3. **Distribution**: `shares` row grants read+run+clone on a skill (or read+open on an app) to a named user; execution always re-gates on the executing user's tokens/attestations.
4. **Apps**: chat produces an artifact → Deploy upserts `apps` row pinning an artifact version → `/apps/{slug}` streams that artifact behind `middleware.ts` auth with a restrictive CSP → Save draft appends versions with agent-written summaries → revert repins.

## Risks & Mitigations

- **Rename churn (`recipe_runs` → `runs`)**: mechanical but wide. Mitigate: single commit, compiler-driven, full test suite + typecheck green before anything else builds on it; migration is `ALTER TABLE ... RENAME` (no data movement, instant on Postgres).
- **Scheduler double-fire**: reuse the proven lease-claim pattern from chat-run worker; test concurrent claims explicitly.
- **Timezone/DST bugs**: isolate `next_run_at` computation in one pure module with table-driven tests including DST boundaries.
- **App content as XSS/exfil vector**: serve with restrictive CSP, same-origin only, redaction at save; document the policy in the app detail UI. Full sandboxing review is a follow-up before org-wide app sharing.
- **Demo scope creep**: the demo checklist is the contract — anything not needed for it lands as a follow-up issue, not in this packet.

## Relationship to other tracks

- **Dispatcher (#104/#105/#106/#110)**: skills carry a declared logical model tier (FR-016); the dispatcher honors declared tiers for skill runs and keeps autopilot for chat. No coupling beyond the model id.
- **AgentCore/Bedrock substrate spike**: unaffected — everything here sits above the seam, which is the point.
- **#26 (Recipes epic)**: superseded by this packet under the Skills name. **#27 (Scheduled agents epic)**: US3 implements its core; SES email delivery and event triggers remain on #27 as follow-ups.
- **#78 (activity feed)**: downstream consumer of `runs` + `shares`; unblocked, not built, by this packet.
