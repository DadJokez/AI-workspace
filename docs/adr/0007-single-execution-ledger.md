# ADR 0007: runs + run_events as the single execution ledger

- **Status:** Accepted
- **Date:** 2026-07-19
- **Deciders:** Rob (owner), Claude/Codex (implementation)

## Context
Comparative executes work from several triggers — interactive chat turns, skill/workflow runs, scheduled occurrences, and inbound event (webhook) deliveries — and each needs the same durable answers: what is running, what failed, who started it, and a reloadable progress stream. The alternative was a separate lifecycle table per trigger type (e.g. a distinct `agent_runs` beside chat), which `docs/RUNS_DECISION.md` rejects as duplicated status/cancel/retry/audit machinery. Trust and IT-legibility matter more than per-type cleverness, so one vocabulary that admins and auditors can reason about wins.

## Decision
Use one generalized execution ledger, `runs`, for every run type, with `run_events` as its append-only, ordered, reloadable event stream. The `runs` table carries a shared `run_status` enum and nullable trigger keys (`skill_id`, `schedule_id`, `event_trigger_id`, `thread_id`) so a chat turn and a scheduled job are the same row shape (`packages/db/src/schema.ts:516-580`); `run_events` fans out from it via `run_id` with `onDelete: cascade` (`packages/db/src/schema.ts:618-652`). That single stream feeds receipts (`apps/web/lib/thread-messages.ts:133-148`), admin traces (`apps/web/app/api/admin/runs/[id]/trace/route.ts:63-78`), and audit is co-keyed through `audit_log.run_id` (`packages/db/src/schema.ts:1337`) — the table was renamed from `recipe_runs` once chat/workflow rows proved it was never recipe-specific.

## Consequences
- **Buys uniform observability:** one status vocabulary (`queued/running/succeeded/failed/canceled`) and one event stream drive receipts, traces, and audit; `workspace_artifacts`, `notifications`, `memory_capture_queue`, and `recommendations` all hang off `run_id` (`schema.ts:821,676,718,893`), so every user-visible output traces back to one ledger row.
- **Buys a resumability substrate:** worker lease/heartbeat/attempt columns on `runs` plus append-only, sequence-ordered `run_events` let a run be claimed, replayed after reconnect, cancelled, and retried through one path rather than per-trigger code.
- **The tree extension is natural:** a `parent_run_id` self-reference (#423) drops onto this single shape to model sub-runs/fan-out without a new lifecycle model — it is not yet in the schema, so it remains planned, not shipped.
- **Costs generality in the row:** trigger keys and `inputs`/`outputs` jsonb are schemaless catch-alls (provider run ids and retry lineage live inside jsonb per `RUNS_DECISION.md`), so most columns are nullable/sparse and there is no per-type lifecycle specialization if one worker class later needs different semantics.
- **Known debt — non-atomic sequence allocation (#443):** `nextRunEventSequence` computes `select coalesce(max(sequence),0)+1` then inserts (`apps/web/lib/chat-inline-runner.ts:1051-1059`), and the `(run_id, sequence, occurred_at)` index is not unique (`schema.ts:649`); concurrent appends to the same run can allocate duplicate sequence numbers.

## Status notes
The non-atomic `run_events` sequence allocation is tracked for a fix in #443 (atomic per-run sequence / unique `(run_id, sequence)` constraint); the `parent_run_id` run-tree extension is tracked in #423.
