# Data Model: Runtime V2 Autopilot

Runtime V2 uses existing tables. No migration is required for the Spec Kit conversion itself.

## `recipe_runs`

Durable execution ledger for chat-originated turns, workflows, scheduled runs, and future recipe runs.

### Relevant Existing Fields

- `id`: run id returned to UI/admin.
- `user_id`: actor.
- `recipe_slug`: `chat-turn` for chat-originated turns.
- `thread_id`: owning chat thread when applicable.
- `trigger_type`: `chat`, `manual`, `scheduled`, or future trigger type.
- `status`: queued/running/succeeded/failed/canceled lifecycle.
- `runtime`: provider/runtime label.
- `model_id`: selected product model id.
- `inputs`: JSON payload containing user message, thread id, execution mode, and route decision.
- `outputs`: JSON payload containing final runtime target, provider metadata, tool results, and metrics.
- `error`: terminal error text.
- `started_at`, `completed_at`: lifecycle timestamps.

### Runtime V2 Input Shape

```json
{
  "prompt": "Can you summarize my last three PRs?",
  "threadId": "uuid",
  "userMessageId": "uuid",
  "executionMode": "local",
  "runtimeRoute": {
    "lane": "tool-local",
    "executionMode": "local",
    "runtimeTarget": "bedrock-agent",
    "useWorker": false,
    "reasons": ["github_recent_work_lookup"]
  }
}
```

### Runtime V2 Output Shape

```json
{
  "runtimeTarget": "direct-chat",
  "modelId": "haiku-4-5",
  "providerRun": {
    "executionMode": "local"
  },
  "metrics": {
    "requestStartedAt": "2026-05-29T12:00:00.000Z",
    "runnerStartedAt": "2026-05-29T12:00:00.050Z",
    "contextPreparedAt": "2026-05-29T12:00:00.120Z",
    "providerStartedAt": "2026-05-29T12:00:00.250Z",
    "firstTokenAt": "2026-05-29T12:00:00.820Z",
    "completedAt": "2026-05-29T12:00:04.500Z",
    "requestToFirstTokenMs": 820,
    "providerToFirstTokenMs": 570,
    "requestToCompletedMs": 4500
  }
}
```

## `run_events`

Append-only progress stream for reloadable run state.

### Runtime V2 Events

- `run_started`: inline fast/tool local run has started.
- `run_queued`: durable run has been queued for worker pickup.
- `run_activity`: route, provider, tool-call, or tool-result progress.
- `run_succeeded`: run completed.
- `run_failed`: run failed.
- `run_canceled`: run canceled.

Events should include route/runtime metadata when useful, but should not store secret values.

## `chat_messages`

Persistent chat message log.

### Runtime V2 Use

- User message is inserted before run dispatch.
- Assistant message is inserted on completion.
- Tool calls/results are stored for `tool-local` and `durable-local` when tools are used.
- Fast-local messages generally have no tool calls/results.

## `audit_log`

Append-only compliance ledger.

### Runtime V2 Use

- MCP tool calls produce audit rows after shared redaction.
- Denied provider/tool access should produce denied audit rows.
- Future rollout work should add audit rows for admin config changes and relevant runtime policy decisions.

## Runtime Route

Route decisions are product-level metadata, not a new table.

```ts
type RuntimeLane = "fast-local" | "tool-local" | "durable-local";
type RuntimeTarget = "direct-chat" | "bedrock-agent" | "agentcore-worker";
type ExecutionMode = "local";

type RuntimeRoute = {
  lane: RuntimeLane;
  executionMode: ExecutionMode;
  runtimeTarget: RuntimeTarget;
  useWorker: boolean;
  reasons: string[];
};
```

Historical admin reporting may still display `cursor-cloud` for older run outputs,
but the current Runtime V2 router no longer produces cloud execution routes.

## Model Mapping Policy

Model mapping is runtime-specific configuration and code.

- Product model ids remain user-facing: `haiku-4-5`, `sonnet-4-6`, `opus-4-7`.
- Fast-local and tool-local Bedrock paths must map to a Bedrock-accessible provider model.
- Durable AgentCore worker paths must use the same product model policy through the runtime seam.
- `RUNTIME_V2_DIRECT_MODEL_ID` provides the direct fast-local default.
- Denied Bedrock models should fall back to a configured allowed model or fail with a clear run error.
