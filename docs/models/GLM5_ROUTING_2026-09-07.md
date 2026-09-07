# GLM-5 routing qualification (#923)

Recorded 2026-09-07T04:08:48Z. Baseline `686b43c` includes #921's
tool-history/schema fix. No model was enabled; no production setting changed.

**Decision: NOT QUALIFIED for routing.** The required bar was 14/14 on
each of three independent runs. GLM-5 scored 14/14, 14/14, **13/14**.
No retry was substituted for the failed run. Sonnet 4.5 scored 14/14 on
all three matched runs.

| Model/run | Pass | Generation USD | Judge USD | Local elapsed seconds | Report |
| --- | --- | --- | --- | --- | --- |
| GLM-5 / 1 | 14/14 | 0.1737554 | 0.0017699 | 60.9 | 2026-09-07T04-03-31-517Z |
| Sonnet 4.5 / 1 | 14/14 | 0.1478623 | 0.0017138 | 67.3 | 2026-09-07T04-04-38-822Z |
| GLM-5 / 2 | 14/14 | 0.1817294 | 0.0016731 | 49.8 | 2026-09-07T04-05-28-613Z |
| Sonnet 4.5 / 2 | 14/14 | 0.1250238 | 0.0017270 | 68.3 | 2026-09-07T04-06-36-879Z |
| GLM-5 / 3 | **13/14** | 0.1963216 | 0.0014410 | 61.4 | 2026-09-07T04-07-38-309Z |
| Sonnet 4.5 / 3 | 14/14 | 0.1258620 | 0.0017072 | 63.9 | 2026-09-07T04-08-42-204Z |

Generation cost totals: GLM-5 $0.5518064; Sonnet $0.3987481, approximately
1.38x. Costs use current registry rates and report token/cache accounting;
these are estimates, not an AWS invoice. Runs alternated GLM/Sonnet to reduce
ordering bias. Local elapsed time is CLI-start-log creation to report
creation (filesystem timestamps), including SDK/tool/judge overhead; the
existing reports do **not** expose per-request latency. Do not interpret
these numbers as isolated model latency or a production SLO benchmark.

## Failure

`model-routing/github-prs-then-gmail-draft` fetched the GitHub PR but did
not call `google__create_draft`. It rendered an inline draft and asked
whether to save it, despite the original request already asking for the
native draft. The failure is deterministic tool-call evidence, not a judge
wording issue. The other two assertions (GitHub called, no web search) passed.

The fixture's `contextReceipts` still contains its baseline `model:
sonnet-4-5` label even during a candidate override. The authoritative
`modelId` and report `candidateModelId` are GLM-5, and the actual invocation
uses that override. This inherited receipt is not used to count results.

## Isolation contract

Tests exercise the real `resolveModelForPurpose` path with only an in-memory
test database and the platform pin mocked off:

- A `(glm-5, routing)` row permits explicit GLM routing selection.
- It does not enable chat, summaries, memory capture or any other purpose,
  including through a preferred model or fallback candidate list.
- Removing the row and invalidating the cache removes the permission.
- A separate pin-active test proves the production Sonnet 4.5 override
  still wins even if a GLM routing row were present.

There were no writes to `model_enablement`, no override flip and no new
model access request. #923 remains open for the unmet qualification bar;
merging this report/tests is not approval to enable GLM-5.

## Reproduce

From the recorded baseline, run each command three times, alternating:

```sh
AWS_REGION=us-east-1 BEDROCK_CLIENT=real pnpm --filter @ai-workspace/evals eval:routing --model glm-5
AWS_REGION=us-east-1 BEDROCK_CLIENT=real pnpm --filter @ai-workspace/evals eval:routing --model sonnet-4-5
```

The comparison uses the repository's 14-case model-routing suite, not a
standalone microbenchmark of a hidden routing classifier. Judge stays Haiku
4.5. Unit contracts and the full local lint/typecheck/test/build gate pass.
