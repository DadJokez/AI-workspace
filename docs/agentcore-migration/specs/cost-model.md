# Spec — Cost Model (10 / 100 / 1000 DAU)

> Projected monthly cost on AgentCore vs. the current Fargate-hosted loop. **No hand-waving:** every
> number states its assumption; un-estimable items are listed with the data needed.

## Pricing inputs (doc-sourced, AgentCore GA 2026-06-18)

| Dimension | Unit price |
|---|---|
| AgentCore compute (CPU) | **$0.0895 / vCPU-hour** (active consumption only — no charge during model I/O wait) |
| AgentCore compute (mem) | **$0.00945 / GB-hour** (active only) |
| Gateway API calls | **$0.005 / 1k** (ListTools/InvokeTool/Ping); search **$0.025 / 1k**; indexing **$0.02 / 100 tools/mo** |
| Memory | short-term **$0.25 / 1k events**; long-term built-in **$0.75 / 1k records/mo** (self-managed $0.25); retrieval **$0.50 / 1k** |
| Identity (non-AWS) | **$0.010 / 1k** token/API-key requests (free via Runtime/Gateway) |
| Harness fee | **none** |
| Model inference (Bedrock) | Haiku ≈ **$0.80 / $4.00**, Sonnet ≈ **$3 / $15**, Opus ≈ **$15 / $75** per 1M in/out ([packages/agent/src/models.ts](../../../packages/agent/src/models.ts)) |
| Fargate (current, us-east-1) | ≈ $0.04048 / vCPU-hr + $0.004445 / GB-hr |

## Workload assumptions (STATED — change these to re-run)

| Variable | Value | Note |
|---|---|---|
| Turns / user / day | **20** | needs real data |
| Active days / month | **22** (business users) | GP internal tool |
| Input tokens / turn | **4,000** | context pack + history + tools ([chat-context-pack.ts](../../../apps/web/lib/chat-context-pack.ts)) |
| Output tokens / turn | **600** | |
| Tool-iteration multiplier | **×1.5** model calls/turn | ~40–50% of turns invoke ≥1 tool ([chat-routing.ts](../../../apps/web/lib/chat-routing.ts)) |
| Model mix | **50% Haiku / 45% Sonnet / 5% Opus** | autopilot biased to quality ([runtime-model-policy.ts](../../../apps/web/lib/runtime-model-policy.ts)) |
| AgentCore active compute / turn | **~5 vCPU-sec, 2 GB** | I/O wait NOT charged; the rest is model latency |
| Memory ops / turn | 2 events + 1 retrieval; ~1 long-term record / session | managed memory ON |
| Gateway calls / turn | ~1 effective | only tool turns |

## Per-turn model cost (the dominant term)

- Haiku: (4000×$0.80 + 600×$4)/1M ×1.5 ≈ **$0.0084**
- Sonnet: (4000×$3 + 600×$15)/1M ×1.5 ≈ **$0.0315**
- Opus: (4000×$15 + 600×$75)/1M ×1.5 ≈ **$0.158**
- **Blended/turn** = 0.50×0.0084 + 0.45×0.0315 + 0.05×0.158 ≈ **$0.0263/turn** → **~$11.6 / user / month**
  (20×22 turns).

## AgentCore non-model per-turn cost

- Compute: (5/3600 vCPU-hr × $0.0895) + (5/3600×2 GB-hr × $0.00945) ≈ **$0.00015/turn** → negligible.
- Memory: 2 events ($0.25/1k) + 1 retrieval ($0.50/1k) ≈ **$0.001/turn**; long-term records add
  ~$0.75/1k/mo.
- Gateway: ~1 call ($0.005/1k) ≈ **$0.000005/turn** → negligible.
- **Sum of AgentCore overhead ≈ $0.0012/turn** — i.e. **~4–5% on top of model cost.**

## Monthly totals by tier

Turns/month = DAU × 20 × 22.

| Tier | Turns/mo | Model inference | AgentCore compute | Memory | Gateway | Observability* | **AgentCore total** |
|---|---|---|---|---|---|---|---|
| **10 DAU** | 4,400 | **$116** | $0.7 | $5 | $0.02 | ~$30 | **~$152 /mo** |
| **100 DAU** | 44,000 | **$1,157** | $7 | $50 | $0.2 | ~$80 | **~$1,294 /mo** |
| **1000 DAU** | 440,000 | **$11,572** | $66 | $500 | $2 | ~$250 | **~$12,390 /mo** |

\*Observability = CloudWatch GenAI ingest/storage — **rough estimate**, scales with span/log volume; firm up after baseline.

## Comparison to current Fargate-hosted cost

| | Current (Fargate loop) | Target (Harness) |
|---|---|---|
| **Model inference** | same Bedrock tokens → **~identical** (model cost doesn't move with where the loop runs) | ~identical |
| **Compute to host the loop** | 3 always-on tasks/cluster ≈ **$36–72/mo** (prod; ×2 if preview cluster on) ([ai-workspace-ecs-stack.ts](../../../infra/cdk/lib/ai-workspace-ecs-stack.ts)) | **~$66/mo at 1000 DAU**, active-consumption; near-$0 at low traffic |
| **Memory/summary** | not shipped (no rolling summary) | **+$500/mo at 1000 DAU** (new capability) |
| **Gateway/Identity** | in-process (free, but we maintain it) | **~$2/mo** + Identity vault (free via Gateway) |
| **Ops/maintenance** | we own loop, sessions, scaling, truncation, retries, tracing | **AWS-managed** (the real saving — eng time, not $) |

## Honest read

1. **Model inference dominates (~93–95% of spend) and does NOT change** between hosting the loop
   ourselves vs. Harness — same tokens, same Bedrock rates. **Do not justify this migration on infra
   cost savings.**
2. **AgentCore adds ~4–5% overhead** (compute + memory + gateway) for managed loop + memory + tracing.
   That overhead is small and buys: rolling-summary memory we never shipped, per-model **cost
   visibility** (today invisible — [01 §8/§11](../01-current-state.md)), instant endpoint rollback,
   and elimination of loop-maintenance eng time.
3. **Biggest cost levers are model-mix + context size**, both controlled by the shell router we keep:
   pushing more turns to **Haiku** and trimming the 4k-token context pack moves the bill far more than
   any infra choice. Mid-session switching (Opus-plan → Sonnet-draft → Haiku-summarize) is a direct
   lever Harness enables.
4. **Turning managed Memory off** for one-shot skill/scheduled runs removes the largest AgentCore-
   specific line item where it adds no value.

## What we need to firm this up (else these are estimates)

- Real **DAU**, **turns/user/day**, and **avg input/output tokens** (instrument now via the token
  metric in [observability-spec.md](observability-spec.md) — we currently emit none).
- Actual prod **model mix** from `runs.modelId`.
- **RDS instance class / Multi-AZ / storage** (not in CDK — imported via SG; likely a real line item
  not modeled here).
- Whether the **runtime-v2 preview cluster** runs continuously (doubles current Fargate compute).
- AgentCore **observability** ingest volume (needs a baseline run).
