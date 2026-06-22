# Spec — Observability (CloudWatch GenAI Observability)

> Closes the gaps from [01 §8](../01-current-state.md): no distributed tracing, no structured JSON
> logs, **no per-model token/cost metric**, no trace correlation web → agent.

## Assumptions

- AgentCore traces every harness step automatically to CloudWatch GenAI Observability (doc-sourced).
- The shell remains the place we write the **redacted** `run_events`/`auditLog` rows
  ([apps/web/lib/run-events.ts](../../../apps/web/lib/run-events.ts)) — Harness tracing is *additive*,
  not a replacement for the audit ledger.
- Correlation key: pass `runs.id` as the Harness session correlator / a trace attribute so a `runs`
  row joins 1:1 to its Harness trace.

## What to log / trace / meter

| Signal | Source | Why |
|---|---|---|
| Per-step trace (model call, tool call, memory op) | Harness GenAI Observability | replaces the missing X-Ray/OTel |
| Token usage per turn (`metadata.usage`: input/output/cache read/write) | `InvokeHarness` response | **the missing cost metric** |
| First-token latency | Harness span timings | replaces bespoke `RuntimeV2Report` p50/p95 ([run-reporting.ts](../../../apps/web/lib/admin/run-reporting.ts)) |
| Tool-call success/error + latency | Gateway logs + Harness spans | tool reliability |
| Evaluator scores (helpfulness/faithfulness/safety + custom) | AgentCore Evaluations | quality regressions |
| Memory op volume (events/records/retrievals) | Memory metrics | cost driver ([cost-model.md](cost-model.md)) |
| Gateway invocation volume | Gateway metrics | cost driver |
| Honesty/attestation/denied-provider events | shell `auditLog` | the trust spine ([01 §9](../01-current-state.md)) |

## Dashboards

1. **Harness health** (per endpoint `DEFAULT`/`STAGING`/`PROD`): first-token p50/p95/p99, full-turn
   p50/p95, error rate, throttle count, active sessions.
2. **Cost & tokens**: input/output/cache tokens by model (Haiku/Sonnet/Opus) per day; estimated
   $/day by model; Gateway invocations/day; Memory events+records+retrievals/day. *This is the single
   most valuable new artifact — today cost is invisible outside Cost Explorer ([01 §11](../01-current-state.md)).*
3. **Tool reliability**: per-target success rate, p95 latency, top errors; denied-provider attestation
   events.
4. **Quality (evals)**: rolling evaluator scores per capability; A/B comparison panels; regression flags.

## Alerts (thresholds — tune after baseline)

| Alarm | Threshold | Action |
|---|---|---|
| First-token p95 (PROD) | > 4s for 5 min | page on-call; consider model/endpoint rollback |
| Turn error rate (PROD) | > 3% for 5 min | page; check Gateway/model throttling |
| Daily model spend | > 1.5× trailing-7-day avg | notify; investigate runaway loop / model mix |
| Per-turn output tokens | p99 > maxTokens×0.95 | review truncation / `maxTokens` config |
| Evaluator faithfulness | drops > 5 pts vs baseline | block promotion; investigate prompt/skill change |
| Memory retrieval errors | > 1% | check actorId scoping / memory resource |
| Gateway target 5xx | > 2% per target | check outbound auth / upstream health |

## Retention

- GenAI Observability traces/metrics: **90 days** hot, archive to S3 if longer needed for audit.
- CloudWatch logs: keep the current **1-month** ECS retention ([ai-workspace-ecs-stack.ts:160](../../../infra/cdk/lib/ai-workspace-ecs-stack.ts));
  extend `/aws/bedrock-agentcore/*` to 90 days for IT review.
- `run_events`/`auditLog` in RDS: governed by the existing `audit:retention` policy (document the
  number in [security-and-compliance.md](security-and-compliance.md)).

## Migration note

The admin `RuntimeV2Report` ([apps/web/lib/admin/run-reporting.ts](../../../apps/web/lib/admin/run-reporting.ts))
is **superseded** by GenAI Observability for latency/failure breakdowns, but keep its lane-level view
(fast/tool/durable) since lane routing stays in the shell ([chat-routing.ts](../../../apps/web/lib/chat-routing.ts)).
