# Regression Gauntlet

Comparative should find boring bugs before Rob does. The testing system is a
layered gauntlet: cheap checks run on every PR, product smoke checks exercise
the browser, real-model evals catch harness/prompt drift, and production smoke
checks the deployed public surface.

## Quality Layers

| Layer | Command / workflow | Runs | Catches |
| --- | --- | --- | --- |
| Unit + contract tests | `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` | Every PR and `main` push via `CI` | Type errors, route contracts, auth checks, DB helper behavior, artifact parsing, routing policy, tool honesty helpers |
| Browser smoke + feature suite | `pnpm smoke:browser` | Every PR and `main` push via `Product Smoke` | The app boots in a real browser, login renders, auth redirect works, theme toggle persists, public model metadata works, anonymous chat is guarded, and local mocked chat flows cover uploads, artifacts, tools, skills, chat download, tabs, retry, Tools, Settings, Vault memory, and persona gating |
| Production public smoke | `pnpm smoke:prod` | Scheduled every 6 hours and manual dispatch via `Product Smoke` | Public deployment health, DB/runtime health, login page, protected redirect, model metadata, anonymous chat guard |
| Real-model evals | `pnpm eval` | Nightly and manual via `Nightly Evals` | Model/prompt/harness regressions: date grounding, Vault truthfulness, tool honesty, skill faithfulness, recommendation faithfulness |
| Manual visual QA | `docs/QA_CHECKLIST.md` | Before large UX releases | Visual polish, mobile ergonomics, artifact preview feel, activity receipts, edge cases that still need judgment |

## Current Automated Coverage

| Product Surface | Unit/Contract | Browser Smoke | Production Smoke | Real-Model Eval | Gap |
| --- | --- | --- | --- | --- | --- |
| Login and auth redirect | Yes | Yes | Yes | No | Full OAuth sign-in still manual |
| Public health/model metadata | Partial | Models only | Yes | No | None for public smoke |
| Chat API guardrails | Yes | Anonymous guard | Anonymous guard | No | Authenticated streaming smoke |
| Fast chat routing | Yes | No | No | Partial | Need seeded signed-in browser/API run |
| Tool/Vault/context honesty | Yes | Vault mocked locally | No | Yes | Need live tool-backed evals with test fixtures |
| File upload parsing | Yes | Mocked local feature flow | No | No | Need live signed-in upload smoke for common business files and model vision |
| Artifact creation + preview | Yes | Mocked local feature flow | No | Partial | Need live signed-in flow for persisted artifact versions |
| Chat download | Yes | Mocked local feature flow | No | No | Need signed-in browser flow |
| Tool activity receipts | Yes | Mocked local feature flow | No | Yes | Need live tool fixture evals with test data |
| Skills and recommendations | Yes | Skills mocked locally | No | Yes | Need recommendation-card browser flow and live skill fixtures |
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
pnpm smoke:prod
pnpm eval --mock
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

## Next Automation Tranches

1. Credentialed test session and signed-in browser flows: #203.
2. Live tool fixtures for routing and honesty evals: #204.
3. Golden chat replays from downloaded failure transcripts: #205.
4. Post-deploy authenticated smoke with a locked-down smoke user: #206.
