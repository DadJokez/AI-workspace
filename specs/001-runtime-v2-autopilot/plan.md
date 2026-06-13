# Implementation Plan: Runtime V2 Autopilot

**Branch**: `codex/spec-kit-runtime-v2` | **Date**: 2026-05-29 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-runtime-v2-autopilot/spec.md`

## Summary

Runtime V2 makes AI Workspace local-first and fast by routing ordinary chat to a direct streaming path, while escalating only when the user asks for connected tools, durable/background work, or explicit Cursor Cloud. The baseline implementation landed in PR #102. This plan converts the work into a Spec Kit packet and tracks the remaining rollout, hardening, and measurement work as GitHub issues.

## Technical Context

**Language/Version**: TypeScript on Node 20

**Primary Dependencies**: Next.js 15, NextAuth v4, Drizzle, `@cursor/sdk`, AWS Bedrock Runtime SDK, AWS CDK TypeScript, pnpm workspaces

**Storage**: RDS Postgres through `packages/db` Drizzle schema; Runtime V2 uses existing `recipe_runs`, `run_events`, `chat_messages`, `audit_log`, `oauth_tokens`, `user_tool_attestations`, and `mcp_servers`

**Testing**: Vitest through `pnpm --filter @ai-workspace/web test`, TypeScript checks, Next build, CDK synth, production/preview smoke tests

**Target Platform**: AWS ECS/Fargate web, chat-worker, and memory-worker services behind ALB; preview stack at `runtime-v2.ai-workspace.builtwithrobot.link`

**Project Type**: Monorepo web app plus runtime packages and CDK infrastructure

**Performance Goals**: Fast-local chat should stream the first token materially faster than the old queued Cursor-agent path; every successful fast-local run should record first-token latency for measurement

**Constraints**: Keep one web task until the shared rate-limit migration is deployed and smoke-tested across multiple web tasks; do not default to Cursor Cloud; do not mount MCP providers for trivial prompts; keep rollback to Cursor agent path available

**Scale/Scope**: Pilot deployment using the existing production database and current ECS services; production rollout after preview smoke and timing comparison

## Constitution Check

- **Single runtime seam**: PASS. Runtime selection stays behind `/api/chat`, `chat-routing`, `chat-inline-runner`, and `AgentRuntime`.
- **MCP is the integration pattern**: PASS. Tool escalation mounts MCP providers; no in-process product tool shortcuts are introduced.
- **Permissions first-class**: PASS. Provider connection/attestation gates still decide what can be mounted.
- **Thin enterprise wrapper**: PASS. Cursor remains the agent harness for tools/durable/cloud; AI Workspace owns routing, persistence, metrics, governance, and UI.
- **No unnecessary abstraction**: PASS. Initial router is deterministic and heuristic; classifier is deferred until data proves it is needed.

## Project Structure

### Documentation (this feature)

```text
specs/001-runtime-v2-autopilot/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── api-chat-runtime-v2.md
├── checklists/
│   └── rollout.md
└── tasks.md
```

### Source Code (repository root)

```text
apps/web/
├── app/api/chat/route.ts
├── app/chat/ChatClient.tsx
├── app/admin/runs/page.tsx
├── app/admin/runs/[id]/page.tsx
├── lib/chat-routing.ts
├── lib/chat-inline-runner.ts
├── lib/chat-run-worker.ts
├── lib/chat-execution-mode.ts
├── lib/run-events.ts
└── __tests__/
    ├── chat-routing.test.ts
    ├── chat-execution-mode.test.ts
    ├── chat-resume.test.ts
    └── run-events.test.ts

packages/
├── cursor-runtime/src/
│   ├── factory.ts
│   ├── cursor-runtime.ts
│   └── bedrock-runtime.ts
├── agent/src/models.ts
└── db/

infra/cdk/lib/
├── ai-workspace-ecs-stack.ts
└── ai-workspace-runtime-v2-preview-stack.ts
```

**Structure Decision**: Runtime V2 remains a web/runtime/infra feature inside the existing monorepo. No new application package or database table is required for this packet.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| None | N/A | N/A |

## Delivery Strategy

1. **Baseline shipped**: PR #102 delivered Runtime V2 preview stack, direct-chat route target, timing marks, admin metric visibility, and preview deployment.
2. **Issue conversion**: This packet creates focused GitHub issues for production rollout, router polish, model fallback, metrics/dashboarding, and shared rate limiting.
3. **Production rollout**: Validate preview through real smoke tests, compare timings, then enable Runtime V2 on production web only.
4. **Autopilot hardening**: Improve router explainability and provider/tool escalation without adding a user-facing mode toggle.
5. **Operational hardening**: Add dashboards, shared rate limiting, and documented App Runner retirement criteria.

## Validation Gates

- `pnpm --filter @ai-workspace/web test -- chat-routing`
- `pnpm --filter @ai-workspace/web typecheck`
- `pnpm --filter @ai-workspace/web build`
- `pnpm --filter @ai-workspace/infra typecheck`
- `pnpm --filter @ai-workspace/infra cdk:synth`
- Preview smoke through `https://runtime-v2.ai-workspace.builtwithrobot.link`
- Production smoke after feature flag enablement

## Open Risks

- Bedrock model access differs from product model labels; denied model selection can make fast chat appear broken.
- Router heuristics may under-escalate ambiguous tool prompts or over-escalate plain chat if keyword matching is too broad.
- Process-local rate limiting blocks safe web scale-out.
- Timing metrics are useful in admin views, but percentile trend visibility still requires a dashboard or query path.
