# Bedrock quota headroom

Comparative production and the live evaluation lane currently share the
account-level Bedrock quota for the active Sonnet 4.5 inference profile. This
runbook records the production guardrail added in #706; it does not claim that
CI and production quota are isolated.

## Current production limit

- AWS Region: `us-east-1`
- Inference profile: `us.anthropic.claude-sonnet-4-5-20250929-v1:0`
- Service Quotas code: `L-381AD9EE`
- Daily token quota: `5,400,000`
- Warning threshold: `4,320,000` tokens (80%)

Verify the live limit instead of assuming this document is current:

```bash
aws service-quotas get-service-quota \
  --region us-east-1 \
  --service-code bedrock \
  --quota-code L-381AD9EE
```

## Alarm contract

`AiWorkspaceEcsStack` owns
`ai-workspace-bedrock-sonnet-4-5-token-headroom`. It sums these `AWS/Bedrock`
metrics for the production inference-profile `ModelId` dimension:

- `InputTokenCount`
- `OutputTokenCount`
- `CacheWriteInputTokens` (the name in the AWS runtime-metrics contract)
- `CacheWriteInputTokenCount` (the name currently emitted in this account)

The quota-weighted expression is:

```text
InputTokenCount
+ MAX(CacheWriteInputTokens, CacheWriteInputTokenCount)
+ (OutputTokenCount * 5)
```

AWS applies a 5x quota burndown to output tokens for Anthropic models through
version 4.7. `CacheReadInputTokens` is deliberately excluded: AWS states that
cache reads do not count toward the runtime token quota. This is quota
accounting, not billing or total-context accounting. See [How tokens are
counted in Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/quotas-token-burndown.html)
and [Bedrock runtime metrics](https://docs.aws.amazon.com/bedrock/latest/userguide/monitoring-runtime-metrics.html).

AWS currently has a naming discrepancy between that documentation and this
account's live `AWS/Bedrock` metrics. On 2026-08-11, `ListMetrics` and
`GetMetricData` showed real nonzero `CacheWriteInputTokenCount` datapoints for
the active inference profile, while the documented `CacheWriteInputTokens`
series was empty. The expression takes the per-period maximum of both aliases
so either service-side spelling is counted without double-counting if AWS
changes the emitted name.

The metric expression treats a missing constituent metric as zero so a sparse
cache-write series cannot suppress input/output consumption. This was checked
against live CloudWatch on 2026-08-11 in both relevant states. With one alias
populated, `GetMetricData` selected the real `CacheWriteInputTokenCount` values
without double-counting. With both cache-write inputs pointed at never-published
metrics, both inputs returned zero datapoints while the exact deployed
expression returned 352 datapoints. Its newest value was `13,457`, exactly
`11,222 + (447 * 5)`, proving that fully absent cache inputs contribute zero
without suppressing the populated input and output series.

The alarm and its recovery notification both route to the existing
`ai-workspace-ops-alerts` SNS topic. Missing data is non-breaching.

The alarm uses a rolling 24-hour sum. Its synthesized definition deliberately
omits `EvaluationWindow`, which CloudWatch defines as the default
`SlidingWindow`; a one-day period does not itself align the data to midnight.
With one 86,400-second period and one evaluation period, the total window is
exactly one day, so CloudWatch evaluates it every minute. Only windows longer
than one day fall back to hourly evaluation. This means the alarm includes the
current partial period and can transition as usage crosses the threshold,
rather than waiting until midnight.

This was checked against live CloudWatch on 2026-08-11. A `GetMetricData`
query with `Period=86400` and `StartTime=12:34 UTC` returned buckets anchored
at `12:34 UTC`, including the in-progress bucket; it did not realign to
`00:00 UTC`. See [Alarm evaluation window](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/alarm-evaluation-window.html)
and [Alarm evaluation](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/alarm-evaluation.html).

The rolling window is conservative for a UTC-calendar-day quota: after AWS
resets the quota it can remain in alarm while prior-day usage ages out. Do not
read it as the exact remaining balance for the current UTC day.

## Responding to an alarm

1. Pause live evaluation runs before customer traffic.
2. Check the current UTC-day token totals for the metrics above.
3. Confirm production health at `/api/health` and run a small authenticated
   chat probe if quota remains.
4. Record which live eval jobs ran and their model usage.
5. Resume live evals only after sufficient headroom or the daily quota reset.

The durable fix remains an isolated quota pool for live CI, such as a separate
AWS account, source Region/model quota, or separately approved runtime
endpoint. A distinct IAM role improves attribution but does not partition an
account-level Bedrock quota.

## Deployment verification

```bash
aws cloudwatch describe-alarms \
  --region us-east-1 \
  --alarm-names ai-workspace-bedrock-sonnet-4-5-token-headroom
```

Verify that `Threshold` is `4320000`, all four metric queries use the active
Sonnet 4.5 profile, and both `AlarmActions` and `OKActions` point to
`ai-workspace-ops-alerts`.
