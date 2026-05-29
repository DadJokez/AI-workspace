# Quickstart: Runtime V2 Autopilot

## 1. Confirm Preview Health

Open:

```text
https://runtime-v2.ai-workspace.builtwithrobot.link/api/health
```

Expected:

- status is healthy or ok
- DB check is healthy
- runtime configuration is present

## 2. Smoke Fast Local Chat

In the Runtime V2 preview app, send:

```text
say pong and nothing else
```

Expected:

- text streams quickly
- no Cloud toggle needed
- admin run detail shows `fast-local`, `direct-chat`, and first-token latency

## 3. Smoke Tool Local Chat

Send:

```text
Can you look at GitHub and summarize my last three PRs?
```

Expected:

- route is `tool-local`
- GitHub MCP is mounted only if connected and approved
- activity timeline shows compact GitHub/tool work
- audit rows are written for tool calls

## 4. Smoke Durable Local Work

Send:

```text
Implement a tiny safe docs fix and run the relevant checks.
```

Expected:

- route is `durable-local`
- UI shows a pending run
- worker claims the run
- refresh preserves pending/completed run state

## 5. Smoke Explicit Cloud

Turn on the one-shot Cloud control and send a prompt.

Expected:

- route is `cursor-cloud`
- run stores `executionMode = cloud`
- the next send defaults back to local

## 6. Review Metrics

Open admin runs:

```text
/admin/runs
```

For each smoke run, confirm:

- route lane
- runtime target
- execution mode
- first-token latency
- total duration
- provider/model error details if failed

## 7. Local Validation Commands

```bash
pnpm --filter @ai-workspace/web test -- chat-routing
pnpm --filter @ai-workspace/web typecheck
pnpm --filter @ai-workspace/web build
pnpm --filter @ai-workspace/infra typecheck
pnpm --filter @ai-workspace/infra cdk:synth
```
