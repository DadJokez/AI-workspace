# Regression Gauntlet

Comparative should find boring bugs before Rob does. The testing system is a
layered gauntlet: cheap checks run on every PR, product smoke checks exercise
the browser, real-model evals catch harness/prompt drift, and production smoke
checks the deployed public surface.

## Quality Layers

| Layer | Command / workflow | Runs | Catches |
| --- | --- | --- | --- |
| Unit + contract tests | `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm eval --mock`, `pnpm transcripts:replay`, `pnpm build` | Every PR and `main` push via `CI` | Type errors, route contracts, auth checks, DB helper behavior, artifact parsing, routing policy, tool honesty helpers, all 126 eval definitions, and scrubbed alpha-failure transcript regressions |
| Browser smoke + feature suite | `pnpm smoke:browser` | Every PR and `main` push via `Product Smoke` | The app boots in a real browser, login renders, auth redirect works, theme toggle persists, public model metadata works, anonymous chat is guarded, and local mocked chat flows cover uploads, artifacts, tools, skills, chat download, conversation navigation, retry, Tools, Settings, Vault memory, and persona gating |
| Real core chat/file pipeline | `pnpm smoke:browser:core` | Every PR and `main` push inside the required `local browser smoke` fan-in, plus every six-hour schedule/manual dispatch | A canary CSV survives the real browser → `/api/chat` → Postgres → agent/resource tool → SSE UI path, thread reload, and a later follow-up without any `/api/chat` interception |
| Authenticated browser smoke | `pnpm smoke:browser:auth` | Every PR and `main` push via `Product Smoke` | Real protected-route access with a test-only NextAuth JWT, disposable Postgres fixtures for the signed-in user and skills catalog, signed-in chat, uploads, generated artifact preview, recommendations, artifacts menu, and transcript download |
| Production public smoke | `pnpm smoke:prod` | Scheduled every 6 hours and manual dispatch via `Product Smoke` | Public deployment health, DB/runtime health, login page, protected redirect, model metadata, anonymous chat guard |
| Production authenticated smoke | `pnpm smoke:prod:auth` | CodeBuild after ECS services stabilize | Signed-in DB/runtime health, locked-down smoke identity, scoped thread access, live signed-in chat, persisted markdown artifact, durable large-upload follow-up, artifact listing, server-side transcript export, AgentCore execution, and failed/stale smoke-run backlog checks |
| Production resource matrix | `pnpm smoke:prod:auth -- --resource-matrix` | Explicit release gate for file-runtime changes | Authenticated upload and later-turn recovery for TXT, CSV, TSV, XLSX, PDF, DOCX, PPTX, PNG, JPG, JPEG, and WebP; stable registry metadata; deterministic complete-source results; full-coverage run receipts; no duplicate artifacts or persisted file excerpts |
| Merge-gate pack | `pnpm eval --gate` | **On demand only** — `gh workflow run product-smoke.yml -f run_evals=true`. NOT a per-PR gate (#706: ~148k Bedrock tokens per run against a non-adjustable 10.8M/day ceiling) | The security/injection spine only, repeat-sampled (attachment, web-fetch, web-search, MCP, GitHub-content, vault-memory). Broad model, prompt, grounding, context, tool, file, and artifact regressions belong to the nightly row below and are **not** blocked pre-merge |
| Comprehensive real-model evals | Independent `pnpm eval` and real-model CSV browser lanes | Nightly at 07:00 UTC and manual via `Nightly Evals` | Full model/prompt/harness regressions plus a separately isolated lane combining real Bedrock with the production preamble, browser, chat API, Postgres, resource serialization, SSE, reload, and follow-up |
| Codex agent-as-user browser canaries | `$comparative-browser-evals` in the Codex in-app Browser | Local nightly advisory task and manual pre-release runs | Whether an agent can discover and complete CSV continuity and artifact lifecycle workflows through visible deployed UI; emits exact `PASS`/`FAIL`/`BLOCKED` scorecards and screenshots |
| Golden transcript replay | `pnpm transcripts:replay` | Every PR and `main` push inside required `CI` | Downloaded chat regressions: denied Vault/tool/artifact access, model label mismatch, competitor-identity claims, missing artifact evidence, missing attachment evidence, manual save instructions after artifact creation, in-place artifact revision (same filename), and cross-thread artifact reference by name |
| Manual visual QA | `docs/QA_CHECKLIST.md` | Before large UX releases | Visual polish, mobile ergonomics, artifact preview feel, activity receipts, edge cases that still need judgment |

## Current Automated Coverage

| Product Surface | Unit/Contract | Browser Smoke | Production Smoke | Real-Model Eval | Gap |
| --- | --- | --- | --- | --- | --- |
| Login and auth redirect | Yes | Yes | Yes | No | Full OAuth sign-in still manual |
| Public health/model metadata | Partial | Models only | Yes | No | None for public smoke |
| Chat API guardrails | Yes | Anonymous guard + signed-in browser smoke | Anonymous guard + signed-in post-deploy smoke | No | Need broader authenticated SSE contract cases in CI |
| Fast chat routing | Yes | No | Signed-in inline artifact smoke | Partial | Need additional production lanes for tool and worker routes |
| Tool/Vault/context honesty | Yes | Vault mocked locally | No | Yes | Fixture-backed GitHub tool evals cover required calls, pending approval, tool errors, and connected-but-not-mounted honesty; live third-party fixture accounts remain future hardening |
| Durable conversation resources | Yes: all accepted extensions at three large sizes, complete adapters, resolver, authorization, receipts | Upload → follow-up → refresh → follow-up | Large CSV continuity on every deploy; full format matrix on file-runtime releases | Yes: 12 production-shaped fixture cases plus nightly real-app/real-Bedrock CSV | Add a recurring model-vision eval after the production image fixtures prove stable |
| Artifact creation + preview | Yes | Mocked local feature flow + signed-in smoke | Persisted artifact API listing | Partial | Browser preview remains local smoke only |
| Chat download | Yes | Mocked local feature flow + signed-in smoke | Server-side transcript export | No | Browser download button remains local smoke only |
| Tool activity receipts | Yes | Mocked local feature flow | No | Yes | Need live tool fixture evals with test data |
| Downloaded chat failure replay | Yes | No | No | No | Golden transcript replay is required in CI; add fixtures whenever an exported-chat bug is found |
| Skills and recommendations | Yes | Mocked local chat + signed-in skills fixture + recommendation action smoke | No | Yes | Meeting Prep and Weekly Status use deterministic provider fixtures; live connected-account smoke remains manual |
| Apps/deploy/update/invite | Partial | No | No | No | Still roadmap work; add E2E as features land |
| Mobile layout | Manual checklist | Login + mocked feature flows | No | No | Need authenticated mobile smoke once test session exists |
| User settings/profile | Partial | Mocked local feature flow | No | No | Need signed-in persistence smoke |
| Tools connection state | Partial | Mocked local feature flow | No | No | Need live OAuth fixture for connected-tool routing |

## Bug To Regression Rule

Every bug that reaches Rob should become one of these before the fix merges:

1. A unit/contract test when the bug is deterministic code behavior.
2. A browser smoke case when the bug is user-visible UI, navigation, upload, preview, or download behavior.
3. A real-model eval case when the bug is assistant behavior, tool honesty, context faithfulness, skill use, or model routing.
4. A production smoke check when the bug is deploy/config/public dependency behavior.

If none of those fit, add a manual QA checklist item and create a follow-up
issue to automate it.

## Context Portability Contract

Durable prompt objects — skills, starter skills, the agent-preamble template,
and context-pack templates — must stay **provider-neutral** so a future model
swap is a config change, not a rewrite (issue #304, part of the #295
model-qualification thesis).

Banned in durable text:

- Provider/model self-references: "as Claude", "you are Claude", "made by
  Anthropic", and equivalent claims for any vendor (ChatGPT/OpenAI/GPT-n,
  Gemini).
- Vendor-specific instruction idioms where a neutral phrasing exists, e.g.
  the Anthropic `<thinking>` tag convention.

Still allowed:

- **Runtime identity injection.** The runtime states the *actual* current
  model at turn time (see `buildAgentPreamble` and the golden transcript
  `identity-comparative-anthropic.md`). Identity honesty is unchanged: a turn
  served by a registry Claude model still self-identifies as that model. The
  neutrality requirement is that a turn served by an unknown/neutral model id
  must not inherit any hardcoded vendor branding.
- **Registry model ids as config vocabulary.** `model: sonnet-4-6` in a skill
  or the Skill Creator's tier guidance names a product registry key, not a
  vendor identity claim.

Enforced by `checkContextPortability` in
`packages/evals/src/portability/context-portability.ts` (pattern deny-list,
no judge calls). The wiring over the real durable objects lives in
`apps/web/__tests__/context-portability.test.ts`, so the check runs on every
PR through the normal `pnpm test` CI step.

## How To Run

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage   # same unit lane + per-package coverage table (report-only)
pnpm build
pnpm smoke:browser
pnpm smoke:browser:auth
pnpm smoke:browser:core
pnpm smoke:prod
pnpm smoke:prod:auth
pnpm smoke:prod:auth -- --resource-matrix
pnpm eval --mock
pnpm --filter @ai-workspace/evals eval:routing --mock
pnpm transcripts:replay
```

Real-model evals need Bedrock access:

```bash
AWS_REGION=us-east-1 BEDROCK_CLIENT=real pnpm eval --gate   # security/injection spine (what CI runs on demand)
AWS_REGION=us-east-1 BEDROCK_CLIENT=real pnpm eval --core   # broad foundational pack
AWS_REGION=us-east-1 BEDROCK_CLIENT=real pnpm eval          # everything (what nightly runs)
AWS_REGION=us-east-1 BEDROCK_CLIENT=real pnpm --filter @ai-workspace/evals eval:routing
```

The GitHub OIDC role, fail-closed workflow behavior, cost tripwires, and
activation commands are documented in
[`EVAL_AUTOMATION_SETUP.md`](./EVAL_AUTOMATION_SETUP.md).

Production smoke defaults to `https://comparative.builtwithrobot.link`; override
it for preview environments:

```bash
SMOKE_BASE_URL=https://your-preview.example.com pnpm smoke:prod
```

Authenticated production smoke runs from CodeBuild after the ECS web, chat
worker, and memory worker services report stable. It reads `DATABASE_URL` and
`NEXTAUTH_SECRET` from the existing `ai-workspace/production/app` Secrets
Manager secret, creates a locked-down `user` role smoke identity, mints a
short-lived normal NextAuth JWT, runs a signed-in chat that must persist a
markdown artifact, verifies the artifact list and protected transcript export,
queues a durable AgentCore worker turn with a built-in tool schema mounted,
checks smoke-run backlog health, and then removes the smoke user data on
success. The durable turn verifies that the deployed runtime version is ready,
the chat worker can invoke it, and Bedrock accepts its tool configuration.
For changes to uploaded-file behavior, run the explicit
`pnpm smoke:prod:auth -- --resource-matrix` gate from the deployed worker image.
It creates valid fixtures for every supported format family, stores them
through the authenticated chat API, verifies the backing resource metadata and
complete adapters, asks later turns to recover beginning/middle/end facts,
checks full-coverage resolver/tool receipts, and proves that neither follow-up
turns nor persisted tool output duplicate file content. This mode is
intentionally not charged on every routine deploy.
Before deployment, the x86 parent job must also observe a successful native ARM
child build for the same source commit; a failed or timed-out child blocks the
stack update and production smoke.
Failed smoke runs leave the tagged smoke rows in place for debugging; the next
run clears stale smoke data before starting. Backlog checks fail on terminal
failures immediately and on active smoke rows only after they are stale, so a
healthy worker claiming the just-created memory job does not flap deploys.

Browser smoke defaults to a local Next dev server. In local mode it enables a
test-only `/e2e/chat` harness that renders the real chat UI with mocked APIs, so
the suite can exercise signed-in chat behavior without production credentials.
Those mocked flows cover image and business-file uploads, artifact
collapse/preview/menu, tool activity receipts, slash skills, chat transcript
download, tab isolation, retry recovery, persona/admin gating, Tools connection
state, Settings saves, and Vault memory approval.
To point the public smoke cases at an already running app:

```bash
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 pnpm smoke:browser
```

When `PLAYWRIGHT_BASE_URL` is set, mocked feature specs are skipped because the
test-only harness is intentionally absent from deployed environments.

Authenticated browser smoke uses the real `/chat` and `/skills` protected
routes. It creates a short-lived NextAuth JWT for a fixed smoke user, runs
against local mocked product APIs for chat data, and seeds a disposable
Postgres database for the signed-in user plus owned/shared/starter skill
fixtures. The production app does not expose this session helper; it only runs
inside the Playwright process.

Golden transcript replay reads scrubbed downloaded chat Markdown fixtures from
`packages/evals/golden-transcripts/`. Each fixture carries a small JSON config
comment that enables deterministic checks for the failure classes Rob has been
pasting back into the chat: capability denial, model-label mismatch, missing
artifact or attachment evidence, and manual copy/save walkthroughs after an
artifact was already created.

## Next Automation Tranches

1. Live third-party fixture accounts for provider-specific end-to-end coverage.
2. Add more golden transcript fixtures as real downloaded-chat bugs appear.
3. Add production smoke lanes for tool-backed and durable-worker chat routes.
4. Unit-test the app publish/deploy secret-scan tripwire (credential-shaped content must be refused before an app ships); see the "Assistant Behavior" pass in `docs/QA_CHECKLIST.md`.
