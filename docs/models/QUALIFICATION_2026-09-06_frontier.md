# Model qualification — the six frontier entries (#920, #797)

The three OpenAI GPT-5.6 entries (#917, `invocation: "responses"`) and the
three Claude 5.x entries (#919, Converse) after Rob accepted the third-party
model agreements on 2026-09-06 (issue #920). This is the sibling of
[`QUALIFICATION_2026-09-06.md`](./QUALIFICATION_2026-09-06.md); the bar,
judge, baseline and command are the same. Nothing here enables a model: no
`model_enablement` row or `PLATFORM_MODEL_OVERRIDE_ID` changed.

- **Rubric version:** `main` @ `e280f15` (#915 judge rubrics + tool receipts;
  #917 Responses route; #918; #919).
- **Judge:** `haiku-4-5`, pinned by the CLI (never follows `--model`).
- **Baseline:** the 2026-09-06 nightly on `sonnet-4-5`
  (`2026-09-06T11-50-05-329Z.json`, Haiku-judged, 147 cases, generation
  $2.18; itself red on three cases — see the sibling doc).
- **Command per model:** `AWS_REGION=us-east-1 BEDROCK_CLIENT=real pnpm
  --filter @ai-workspace/evals exec tsx src/run.ts --model <id> --baseline
  eval-reports/nightly-0906/2026-09-06T11-50-05-329Z.json`; budget $6 / 45
  min per model ($10 for `opus-5`), $40 for the lane.
- **Order:** `gpt-5-6-terra`, `gpt-5-6-sol`, `gpt-5-6-luna`, then `sonnet-5`,
  `opus-5`, `fable-5-1` as access opened.

## Outcome: none of the six was invocable inside the window — $0.00 spent

The control plane says every one of the six is fully authorised; the data
plane refuses every call with the Marketplace "not available for this
account" message. That is the same state #919 recorded for the Claude 5.x
entries before the agreements were accepted, now with
`agreementAvailability: AVAILABLE` instead of `NOT_AVAILABLE` / `PENDING`.

`aws bedrock get-foundation-model-availability --region us-east-1`, all six,
2026-09-06T23:41Z (identical at 23:49Z and at 00:25Z, after the window):

```json
{ "agreementAvailability": { "status": "AVAILABLE" },
  "authorizationStatus": "AUTHORIZED",
  "entitlementAvailability": "AVAILABLE",
  "regionAvailability": "AVAILABLE" }
```

The runtime error, verbatim (Converse, Anthropic):

```
An error occurred (AccessDeniedException) when calling the Converse operation:
anthropic.claude-sonnet-5 is not available for this account. You can explore
other available models on Amazon Bedrock. For additional access options,
contact AWS Sales at https://aws.amazon.com/contact-us/sales-support/
```

and through the Responses route (`BedrockResponsesClient`, OpenAI):

```
Bedrock Responses API request failed (HTTP 403; request id
4e1e34a8-f576-4e44-bc7e-63c9bb96fc92): openai.gpt-5.6-terra is not available
for this account. You can explore other available models on Amazon Bedrock.
For additional access options, contact AWS Sales at
https://aws.amazon.com/contact-us/sales-support/
```

### Re-probe timeline

One bounded call per model per attempt — `aws bedrock-runtime converse`
("Reply with the single word ok", `maxTokens: 8`) on the `us.` profile for
the Claude entries; the same prompt through `runAgentLoop` →
`RealBedrockClient` → `BedrockResponsesClient` for the GPT entries — every
five minutes for forty minutes after the agreements showed `AVAILABLE`.

| Attempt (UTC) | `sonnet-5` | `opus-5` | `fable-5-1` | `gpt-5-6-terra` | `gpt-5-6-sol` | `gpt-5-6-luna` |
| --- | --- | --- | --- | --- | --- | --- |
| 23:42 / 23:43 (first probe) | AccessDenied | AccessDenied | AccessDenied | HTTP 403 | HTTP 403 | HTTP 403 |
| 23:47 / 23:49 | AccessDenied | AccessDenied | AccessDenied | HTTP 403 | HTTP 403 | HTTP 403 |
| 23:52 / 23:54 | AccessDenied | AccessDenied | AccessDenied | HTTP 403 | HTTP 403 | HTTP 403 |
| 23:57 / 23:59 | AccessDenied | AccessDenied | AccessDenied | HTTP 403 | HTTP 403 | HTTP 403 |
| 00:02 / 00:04 | AccessDenied | AccessDenied | AccessDenied | HTTP 403 | HTTP 403 | HTTP 403 |
| 00:07 / 00:09 | AccessDenied | AccessDenied | AccessDenied | HTTP 403 | HTTP 403 | HTTP 403 |
| 00:12 / 00:14 | AccessDenied | AccessDenied | AccessDenied | HTTP 403 | HTTP 403 | HTTP 403 |
| 00:17 / 00:19 | AccessDenied | AccessDenied | AccessDenied | HTTP 403 | HTTP 403 | HTTP 403 |
| 00:22 / 00:24 (window closed) | AccessDenied | AccessDenied | AccessDenied | HTTP 403 | HTTP 403 | HTTP 403 |

Control plane at close (00:25Z): unchanged, `agreementAvailability:
AVAILABLE` on all six.

Every refusal carried the same "is not available for this account" text and
came back in 120–620 ms, before any token was generated; the 403 is the
service authenticating the SigV4 request and resolving the model before
refusing on the account, so the Responses-route auth + endpoint path is
right and the wire shape past that point is still proven only by the mocked
exit test (#917).

## Summary

| Model | Bedrock id | Runnable? | Passed / failed | CRITICAL misses | HIGH misses | Cost (candidate + judge) | Wall | Identity (3×) | Recommendation (Rob decides) | #797 comment |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |
| `gpt-5-6-terra` | `us.openai.gpt-5.6-terra` | **no** — `HTTP 403 … openai.gpt-5.6-terra is not available for this account` through the Responses route, on every attempt of the 40-minute window | – | – | – | $0.00 | – | – | none possible; re-run is one command once the data plane admits the account | [comment](https://github.com/DadJokez/AI-workspace/issues/797#issuecomment-5563367846) |
| `gpt-5-6-sol` | `us.openai.gpt-5.6-sol` | **no** — same HTTP 403 | – | – | – | $0.00 | – | – | none possible | [comment](https://github.com/DadJokez/AI-workspace/issues/797#issuecomment-5563367970) |
| `gpt-5-6-luna` | `us.openai.gpt-5.6-luna` | **no** — same HTTP 403 | – | – | – | $0.00 | – | – | none possible | [comment](https://github.com/DadJokez/AI-workspace/issues/797#issuecomment-5563368109) |
| `sonnet-5` | `us.anthropic.claude-sonnet-5` | **no** — `AccessDeniedException: anthropic.claude-sonnet-5 is not available for this account` on Converse, every attempt | – | – | – | $0.00 | – | – | none possible | [comment](https://github.com/DadJokez/AI-workspace/issues/797#issuecomment-5563368254) |
| `opus-5` | `us.anthropic.claude-opus-5` | **no** — same AccessDeniedException | – | – | – | $0.00 | – | – | none possible | [comment](https://github.com/DadJokez/AI-workspace/issues/797#issuecomment-5563368354) |
| `fable-5-1` | `us.anthropic.claude-fable-5-1` | **no** — same AccessDeniedException; the model card additionally requires the `aws_review` data-retention opt-in | – | – | – | $0.00 | – | – | none possible; see the toolChoice note below | [comment](https://github.com/DadJokez/AI-workspace/issues/797#issuecomment-5563368494) |

## What was verified without spend

- **The lane is one command away.** `pnpm --filter @ai-workspace/evals exec
  tsx src/run.ts --mock --model gpt-5-6-terra` renders the full 147-case
  structural pack and scorecard on this branch; the real command differs only
  by `BEDROCK_CLIENT=real` and `--baseline`. The 2026-09-06 nightly baseline
  is in place (gitignored) so the known-red parity and spend checks run.
- **No Responses-route quirk could be observed** (function-call history ids,
  `temperature` rejection, the 64-char function-name cap): every request
  died at the account gate. For the record, the longest tool name the pack
  mounts is 34 characters (`comparative-conversation-resources`), so the cap
  cannot bite the qualification run.
- **Fable 5.1's model-card constraints are not exercised by the pack.** The
  harness passes neither `temperature` nor `requiredToolName` to
  `runAgentLoop`, so the qualification run sends neither a temperature nor a
  forced `toolChoice`. The forced `toolChoice: {tool: {name}}` the loop sends
  for a required MCP tool (`packages/agent/src/loop.ts`, first step only) is
  a production path — calendar confirmed writes — that Fable 5.1 would need an
  `any`/`auto` fallback for; that exception is deferred until the first real
  probe shows the rejection (no code changed on this branch).

## Reading the control-plane / data-plane split

Two different gates answer the two calls:

- `get-foundation-model-availability` reports the **agreement** (accepted via
  `create-foundation-model-agreement`, now `AVAILABLE`), the account's IAM
  authorisation, entitlement and region — all green.
- Converse / the Responses API refuse with the **Marketplace account** message.
  The same text appeared before any agreement existed (#917, #919), so the
  agreement was necessary but is not the last gate: either the Marketplace
  subscription is still propagating past forty minutes, or the account needs
  the AWS-side grant the runbook describes for Marketplace-billed models
  ("an account-level grant AWS has to make"; the message itself points at
  AWS Sales).

Next step is Rob's (issue #920): re-check the runtime, and if the 403
persists, take the request-id above to AWS support / the account team. Once
one bounded call answers, the six qualification runs are the command at the
top of this file, in the order listed.
