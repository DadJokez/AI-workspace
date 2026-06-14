# Runtime V2 Autopilot Spec

> Spec Kit packet: [`specs/001-runtime-v2-autopilot`](../specs/001-runtime-v2-autopilot/).
> This document is the original design note; use the Spec Kit packet for
> implementation tasks, rollout checklist, and GitHub issue traceability.

## Purpose

AI Workspace should feel fast for ordinary chat without asking users to choose
between "chat" and "agent" modes. The runtime should start with the simplest
local streaming path that can satisfy the request, then escalate automatically
when the user asks for tools, repository work, or long-running execution.

Runtime V2 keeps one product-facing runtime seam, but stops using the queued
worker path as the default for every turn. Simple chat streams directly through
the web task on Bedrock. Tool work stays inline on Bedrock with MCP. Code and
durable work uses AgentCore.

## Experience Goals

- Normal chat starts streaming quickly and does not create a queued worker run
  unless it needs durable execution.
- The user does not need a mode toggle for ordinary operation.
- The router can explain why a turn used direct chat, tool-enabled chat, or a
  durable worker.
- Every run stores timing marks, including first-token latency, so we can
  compare runtime changes with real production data.

## Runtime Lanes

| Lane | Target | Worker | Tools | Used For |
| --- | --- | --- | --- | --- |
| `fast-local` | `direct-chat` | no | no | Ordinary chat, lightweight reasoning, vault-aware answers |
| `tool-local` | `bedrock-agent` | no | yes | GitHub/MCP inspection and interactive tool turns |
| `durable-local` | `agentcore-worker` | yes | yes | Code changes, repo work, tests, deploys, long-running work |

The key design choice: this is an autopilot, not a product toggle. The route is
derived from the prompt, request metadata, and run history.

## First Slice

1. Add `runtimeTarget: "direct-chat" | "bedrock-agent" | "agentcore-worker"` to the chat route.
2. Gate direct chat behind `RUNTIME_V2_ENABLED=1`.
3. Make `fast-local` use the Bedrock-backed direct runtime when Runtime V2 is
   enabled.
4. Keep tool turns on Bedrock with MCP and durable turns on AgentCore.
5. Map provider-facing model ids to Bedrock model ids for direct chat.
6. Store route/runtime/model choices in `recipe_runs.inputs` and
   `recipe_runs.outputs`.
7. Record timing marks:
   - request accepted
   - inline runner started
   - context prepared
   - provider run started
   - first token streamed
   - run completed
8. Show first-token latency in the admin run list/detail pages.

## Preview Environment

Runtime V2 gets its own ECS preview stack and URL:

- URL: `https://runtime-v2.ai-workspace.builtwithrobot.link`
- Cluster: `ai-workspace-runtime-v2`
- Services:
  - `ai-workspace-runtime-v2-web`
  - `ai-workspace-runtime-v2-chat-worker`
  - `ai-workspace-runtime-v2-memory-worker`
- Images:
  - `runtime-v2-latest`
  - `runtime-v2-worker-latest`
  - `runtime-v2-memory-worker-latest`

Preview uses the existing production database and app secret for a fast test
loop, but sets `RUNTIME_V2_ENABLED=1` and `BEDROCK_CLIENT=real`.

## Escalation Policy

Runtime V2 starts direct and escalates when the prompt signals that direct chat
is unlikely to be enough:

- GitHub, PR, issue, CI, or repository inspection -> `tool-local`
- code changes, tests, deploys, migrations, infra, or background work ->
  `durable-local`
- personal context/vault request -> `fast-local` with vault context

Future slices can add richer escalation using a cheap classifier, tool registry
metadata, per-user connected MCP inventory, and failed-direct fallback.

## Measurements

Each chat run should store a `metrics` object in outputs:

```json
{
  "requestStartedAt": "2026-05-25T12:00:00.000Z",
  "providerStartedAt": "2026-05-25T12:00:00.400Z",
  "firstTokenAt": "2026-05-25T12:00:00.850Z",
  "completedAt": "2026-05-25T12:00:04.500Z",
  "requestToFirstTokenMs": 850,
  "providerToFirstTokenMs": 450,
  "requestToCompletedMs": 4500
}
```

The first useful comparison is simple:

- Runtime V2 `fast-local` using direct chat
- Runtime V2 `tool-local` using Bedrock + MCP
- Runtime V2 `durable-local` using AgentCore

## Rollout

1. Build and deploy the preview stack.
2. Add the preview GitHub OAuth callback URL if login requires it.
3. Run production-like smoke tests through the preview URL.
4. Compare first-token latency and total duration in `/admin/runs`.
5. If the numbers are good, enable Runtime V2 on production web only.
6. Keep the previous production image available for rollback during deployment.

## Open Follow-Ups

- Add a lightweight classifier when regex routing stops being enough.
- Consider a warm direct-chat client per task if Bedrock client setup becomes
  measurable.
- Move rate limiting to shared storage before scaling web beyond one task.
- Add percentile dashboards from run metrics once enough sample data exists.
