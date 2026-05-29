# Local-First Runtime Routing Issue/Spec

> Spec Kit packet: [`specs/001-runtime-v2-autopilot`](../specs/001-runtime-v2-autopilot/).
> This document captures the routing problem statement; use the Spec Kit packet
> for the current task list and rollout tracking.

## Summary

AI Workspace should operate in the simplest runtime lane that can satisfy the user's ask. Normal chat must default to local, direct streaming with no tools mounted and no background worker. The system escalates only when the ask requires connected tools, durable background work, or an explicit cloud run.

## Problem

The ECS cutover removed App Runner constraints, but normal chat still pays for the old durable-run architecture:

- `/api/chat` always creates a queued `recipe_runs` row.
- A separate worker claims the run and calls Cursor.
- The UI polls for completed messages.
- GitHub MCP/tool context can be mounted even for trivial prompts.

For simple prompts like "say pong", this adds avoidable latency. Direct Cursor SDK calls without tools are much faster than the full queued path.

## Goals

- Default chat path is local, streaming, and tool-free.
- Preserve model selection and normal conversation continuity.
- Mount MCP providers only when the request likely needs them.
- Use the Fargate worker for durable work that should survive disconnects, refreshes, or long execution.
- Use Cursor Cloud only when the user explicitly asks for it through the one-shot Cloud control, or when a future router rule makes that escalation deliberate and observable.
- Keep `recipe_runs` and `run_events` as the audit/debug ledger for every chat turn, including inline turns.

## Non-Goals

- Do not remove the durable worker path.
- Do not remove Cursor Cloud support.
- Do not build a heavy model-based router before the simple heuristic router proves insufficient.
- Do not mount every connected MCP provider on every request.

## Runtime Lanes

### 1. Fast Local Chat

Default lane.

- Runs inside the web request.
- Uses `getRuntime({ executionMode: "local" })`.
- Streams `text-delta` events directly to the client.
- Does not mount MCP providers.
- Does not include Vault memory unless the prompt asks for personal context.
- Persists the assistant answer and run ledger when done.

### 2. Local Tool Chat

Still local and streaming, but with narrowly mounted tools.

- Triggered by tool intent such as asking to inspect GitHub, issues, PRs, commits, branches, Actions, or repositories.
- Mounts only the provider(s) inferred from the prompt.
- Streams tool activity and final text directly.
- Persists tool calls/results to `chat_messages`, `run_events`, and `audit_log`.

### 3. Durable Fargate Work

For work that should not depend on the browser request staying open.

- Triggered by long-running implementation/build/deploy/refactor/test/research wording.
- Enqueues a `recipe_runs` row for the chat worker.
- The worker runs local Cursor by default.
- The UI uses the existing pending-run refresh path.

### 4. Explicit Cursor Cloud

For the existing one-shot Cloud control.

- Triggered only by `executionMode: "cloud"` from the UI/API.
- Enqueues the durable worker path with Cursor Cloud execution.
- Retries/resumes preserve the explicit cloud mode.

## Initial Router Rules

The first router is intentionally conservative and deterministic:

- `executionMode === "cloud"` -> explicit Cursor Cloud worker.
- Durable keywords such as `implement`, `build`, `deploy`, `refactor`, `run tests`, `fix bug`, `open a PR`, or `keep working` -> durable local worker.
- GitHub/tool keywords such as `GitHub`, `repo`, `issue`, `pull request`, `PR`, `commit`, `branch`, `workflow`, `Actions`, or `CI`, combined with an action-oriented request -> local tool chat.
- Personal-context keywords such as `remember`, `what do you know about me`, `my preferences`, `vault`, or `based on what you know` -> fast local chat with Vault context.
- Everything else -> fast local chat.

Router decisions are written into `recipe_runs.inputs.runtimeRoute` and `run_events` metadata for debugging.

## Acceptance Criteria

- A simple chat request streams inline and completes without a queued worker hop.
- A simple chat request stores `runtimeRoute.lane = "fast-local"` and `executionMode = "local"`.
- A GitHub-looking request streams inline with `runtimeRoute.lane = "tool-local"` and mounts GitHub MCP when available.
- A durable-looking request stores `runtimeRoute.lane = "durable-local"` and is picked up by the chat worker.
- The Cloud toggle still stores/runs `executionMode = "cloud"` and uses the durable worker path.
- Retry/resume behavior for durable runs remains unchanged.

## Test Plan

- Unit tests for router classification.
- Existing chat execution-mode tests.
- Existing vault-memory tests.
- Web typecheck.
- Web build.
- Production smoke after deploy:
  - `say pong and nothing else` streams without a queued-worker wait.
  - A GitHub/tool prompt mounts tools.
  - A durable prompt creates a pending run.
  - Explicit Cloud still queues a cloud run.
