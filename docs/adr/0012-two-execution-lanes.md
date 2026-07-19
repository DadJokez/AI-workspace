# ADR 0012: Two execution lanes: inline streaming + durable worker

- **Status:** Accepted — under revision (#442)
- **Date:** 2026-07-19
- **Deciders:** Rob (owner), Claude/Codex (implementation)

## Context
A chat turn has two conflicting delivery needs. An interactive turn wants the first token on screen as fast as possible, streamed over the open SSE request. A background turn — a skill, a scheduled occurrence, or a GitHub-event trigger — has no open request to stream into and must survive the web process restarting mid-run, so it needs to be claimed, heartbeated, and retried. The router already classifies each turn into a lane and sets a single boolean, `useWorker`, off the lane (`durable-local` → `true`; `fast-local`/`tool-local` → `false`) in `apps/web/lib/chat-routing.ts:119,135,151,165,181,243`.

## Decision
Run interactive turns inline and durable turns in a lease-based worker, both writing the same `runs` row and `run_events` sequence. When `useWorker` is false the request handler calls `streamInlineChatRun` directly inside the SSE `ReadableStream` and pipes `text-delta` events to the client (`apps/web/app/api/chat/route.ts:745,757`; `apps/web/lib/chat-inline-runner.ts:137,458,525`). When `useWorker` is true the run is enqueued `status: "queued"` and `startInProcessChatRunWorker` claims it under a lease — `workerId` / `leaseExpiresAt` / `attemptCount` / `lastHeartbeatAt` on the `runs` table (`packages/db/src/schema.ts:551-554`, claim index `:567`), atomically claimed in `claimChatRun` with an expired-lease reclaim path and a renewing heartbeat (`apps/web/lib/chat-run-worker.ts:148,223-263,565,1109`). Both lanes append to the shared run/run_events contract via the same helpers (`appendRunEventWithNextSequence`, `appendToolCallRunEvent`, `appendToolResultRunEvent` — `apps/web/lib/run-events.ts:82`), so replay and the Run Inspector are lane-agnostic.

## Consequences
- **Buys interactive latency:** the inline lane streams first token, live token counts, and redacted tool events straight to the browser (`chat-inline-runner.ts:527,577,591-595`) with per-stage timing metrics (`:470,531,698`) — no queue hop.
- **Buys durability:** worker runs survive client disconnect and process restart. A dead worker's lease expires and another claim reclaims the run (`chat-run-worker.ts:256,275`), `attemptCount` bounds retries, and a wall-clock timeout aborts a stuck runtime (`:553`). It also fires proactive notifications the inline lane doesn't (`:1026`).
- **Costs a duplicated pipeline that has drifted (self-review Top-1):** the two runners re-implement the same sequence — context-pack assembly, MCP mounting, tool-discovery, the `runtime.runTurn` event loop, and assistant persistence — independently, and they have diverged. Examples: inline resolves the model per lane purpose via `resolveRuntimeModelSelection` / `enabledModelsForPurpose` (`chat-inline-runner.ts:162-169`) while the worker uses `run.modelId` verbatim (`chat-run-worker.ts:630`); inline passes `systemPrompt` + `volatileSystemSuffix`, the worker passes `firstTurnPreamble` (`chat-run-worker.ts:634`); the worker prefers the artifact-lookup fallback for its trigger types, inline never does (`chat-run-worker.ts:363-365`); timing metrics and the live redacted SSE exist only inline. Every pipeline change must now be made twice or one lane silently regresses.
- **Forecloses nothing structural** — the two-lane split is the right shape; only the copy-paste is the debt.

## Status notes
Under revision in **#442** (runner extraction, `executeChatTurn`). #442 keeps the two-lane decision — inline SSE for interactive, durable worker for background — and removes only the duplication by having both lanes call one shared turn executor. This ADR's decision stands; its *mechanism* (two hand-maintained copies of the pipeline) is superseded.
