# Regression Gauntlet

Comparative should find boring bugs before Rob does. The testing system is a
layered gauntlet: cheap checks run on every PR, product smoke checks exercise
the browser, real-model evals catch harness/prompt drift, and production smoke
checks the deployed public surface.

## Quality Layers

| Layer | Command / workflow | Runs | Catches |
| --- | --- | --- | --- |
| Unit + contract tests | `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` | Every PR and `main` push via `CI` | Type errors, route contracts, auth checks, DB helper behavior, artifact parsing, routing policy, tool honesty helpers |
| Browser smoke + feature suite | `pnpm smoke:browser` | Every PR and `main` push via `Product Smoke` | The app boots in a real browser, login renders, auth redirect works, theme toggle persists, public model metadata works, anonymous chat is guarded, and local mocked chat flows cover uploads, artifacts, tools, skills, chat download, conversation navigation, retry, Tools, Settings, Vault memory, and persona gating |
| Authenticated browser smoke | `pnpm smoke:browser:auth` | Every PR and `main` push via `Product Smoke` | Real protected-route access with a test-only NextAuth JWT, disposable Postgres fixtures for the signed-in user and skills catalog, signed-in chat, uploads, generated artifact preview, recommendations, artifacts menu, and transcript download |
| Production public smoke | `pnpm smoke:prod` | Scheduled every 6 hours and manual dispatch via `Product Smoke` | Public deployment health, DB/runtime health, login page, protected redirect, model metadata, anonymous chat guard |
| Production authenticated smoke | `pnpm smoke:prod:auth` | CodeBuild after ECS services stabilize | Signed-in DB/runtime health, locked-down smoke identity, scoped thread access, live signed-in chat, persisted markdown artifact, artifact listing, server-side transcript export, and failed/stale smoke-run backlog checks |
| Real-model evals | `pnpm eval` | Nightly and manual via `Nightly Evals` | Model/prompt/harness regressions: date grounding, Vault truthfulness, fixture-backed GitHub tool routing, tool honesty, skill faithfulness, recommendation faithfulness, artifact content treated as inert data, memory-capture secret redaction, provider-missing skill honesty |
| Golden transcript replay | `pnpm transcripts:replay` | Manual today; CI candidate after fixture count grows | Downloaded chat regressions: denied Vault/tool/artifact access, model label mismatch, competitor-identity claims, missing artifact evidence, missing attachment evidence, manual save instructions after artifact creation, in-place artifact revision (same filename), and cross-thread artifact reference by name |
| Manual visual QA | `docs/QA_CHECKLIST.md` | Before large UX releases | Visual polish, mobile ergonomics, artifact preview feel, activity receipts, edge cases that still need judgment |

## Current Automated Coverage

| Product Surface | Unit/Contract | Browser Smoke | Production Smoke | Real-Model Eval | Gap |
| --- | --- | --- | --- | --- | --- |
| Login and auth redirect | Yes | Yes | Yes | No | Full OAuth sign-in still manual |
| Public health/model metadata | Partial | Models only | Yes | No | None for public smoke |
| Chat API guardrails | Yes | Anonymous guard + signed-in browser smoke | Anonymous guard + signed-in post-deploy smoke | No | Need broader authenticated SSE contract cases in CI |
| Fast chat routing | Yes | No | Signed-in inline artifact smoke | Partial | Need additional production lanes for tool and worker routes |
| Tool/Vault/context honesty | Yes | Vault mocked locally | No | Yes | Fixture-backed GitHub tool evals cover required calls, pending approval, tool errors, and connected-but-not-mounted honesty; live third-party fixture accounts remain future hardening |
| File upload parsing | Yes | Mocked local feature flow + signed-in smoke payloads | No | No | Need model vision evals for screenshots |
| Artifact creation + preview | Yes | Mocked local feature flow + signed-in smoke | Persisted artifact API listing | Partial | Browser preview remains local smoke only |
| Chat download | Yes | Mocked local feature flow + signed-in smoke | Server-side transcript export | No | Browser download button remains local smoke only |
| Tool activity receipts | Yes | Mocked local feature flow | No | Yes | Need live tool fixture evals with test data |
| Downloaded chat failure replay | Yes | No | No | No | Golden transcript replay now covers exported-chat bug classes; wire into CI after more fixtures accumulate |
| Skills and recommendations | Yes | Mocked local chat + signed-in skills fixture + recommendation action smoke | No | Yes | Need live skill/tool fixture evals |
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

## How To Run

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm smoke:browser
pnpm smoke:browser:auth
pnpm smoke:prod
pnpm smoke:prod:auth
pnpm eval --mock
pnpm transcripts:replay
```

Real-model evals need Bedrock access:

```bash
AWS_REGION=us-east-1 BEDROCK_CLIENT=real pnpm eval
```

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
checks smoke-run backlog health, and then removes the smoke user data on
success. Failed smoke runs leave the tagged smoke rows in place for debugging;
the next run clears stale smoke data before starting. Backlog checks fail on
terminal failures immediately and on active smoke rows only after they are stale,
so a healthy worker claiming the just-created memory job does not flap deploys.

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
