# Contract: Runtime V2 Chat Routing

## `POST /api/chat`

Starts a chat turn and returns an SSE stream.

### Request Body

```json
{
  "threadId": "uuid-or-null",
  "messages": [
    { "id": "local-id", "role": "user", "content": "Can you summarize my last three PRs?" }
  ],
  "modelId": "haiku-4-5",
  "executionMode": "local"
}
```

### Request Fields

- `threadId`: Existing thread id or null for a new thread.
- `messages`: Client-visible message list. The server persists the newest user prompt.
- `modelId`: Product model id.
- `executionMode`: Optional. Defaults to `local`. `cloud` is only sent by the one-shot Cloud control.

### Route Decision

The server computes a runtime route before dispatch:

```json
{
  "lane": "fast-local",
  "executionMode": "local",
  "runtimeTarget": "direct-chat",
  "useWorker": false,
  "reason": "default-fast-local"
}
```

### SSE Events

Runtime V2 should preserve the existing client stream shape while adding route metadata where already supported.

```text
event: run
data: {"runId":"uuid","runtimeRoute":{"lane":"fast-local","runtimeTarget":"direct-chat","useWorker":false}}

event: text-delta
data: {"delta":"pong"}

event: done
data: {"runId":"uuid","messageId":"uuid"}
```

Durable/cloud routes may return a queued run event and rely on polling/reload to show final output.

```text
event: run
data: {"runId":"uuid","runtimeRoute":{"lane":"durable-local","runtimeTarget":"cursor-agent","useWorker":true},"queued":true}
```

## Runtime Lane Contract

| Lane | `runtimeTarget` | `executionMode` | `useWorker` | Expected behavior |
| --- | --- | --- | --- | --- |
| `fast-local` | `direct-chat` when V2 enabled | `local` | `false` | Inline streaming, no tools |
| `tool-local` | `cursor-agent` | `local` | `false` | Inline streaming with narrow MCP mount |
| `durable-local` | `cursor-agent` | `local` | `true` | Queued worker run |
| `cursor-cloud` | `cursor-agent` | `cloud` | `true` | Queued worker run with Cursor Cloud |

## Admin Run Views

Admin run list and detail pages must read these output fields when present:

```json
{
  "runtimeTarget": "direct-chat",
  "providerRun": {
    "executionMode": "local"
  },
  "metrics": {
    "requestToFirstTokenMs": 820,
    "providerToFirstTokenMs": 570,
    "requestToCompletedMs": 4500
  }
}
```

## Error Contract

Provider/model access errors should be stored in `recipe_runs.error` and surfaced clearly to the user. The error path should include:

- provider/runtime name
- product model id
- direct/provider model id when available
- original provider error class/message after secret redaction
- route lane and runtime target

## Environment Contract

Runtime V2 reads:

- `RUNTIME_V2_ENABLED`: enables direct-chat fast-local routing.
- `RUNTIME_V2_DIRECT_RUNTIME`: direct runtime, initially `bedrock`.
- `RUNTIME_V2_DIRECT_MODEL_ID`: allowed direct model default.
- Existing Cursor Cloud env/secrets for explicit `cursor-cloud`.
- Existing provider OAuth/token env/secrets for MCP-mounted routes.
