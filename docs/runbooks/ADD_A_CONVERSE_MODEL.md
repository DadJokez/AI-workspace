# Runbook: add a Bedrock Converse model

**Status: written; rehearsed on `nova-pro` (2026-09-05, #797 P3) and
`gpt-oss-120b` (2026-09-06) through step 5. Steps 6–7 — the enablement flip —
have never been executed.**

**Purpose.** Put a new Bedrock model behind Comparative as a registry entry,
prove it with the qualification pack, and (Rob only) turn it on per purpose.
The epic's target is under an hour of developer work with no code change
beyond the registry entry; the honest accounting is in the last section.

Nothing here enables a model. Registration is unattended-safe; the enablement
click is Rob's (#301/#302/#305).

## What you need

- AWS credentials in account `351478076796` that can call
  `bedrock:ListFoundationModels`, `bedrock:ListInferenceProfiles` and
  `bedrock:InvokeModel` (the `local-dev` user can). Production's ECS task role
  already grants `bedrock:InvokeModel*` on `*`, so production needs no IAM
  change for a new model; the **nightly eval role does** (step 8).
- For step 5, real-model Bedrock spend: the full pack on `nova-pro` was 16
  minutes and $1.28 (about half of it the pinned Sonnet judge, which draws on
  the shared quota, #706). Runs are Rob-dispatched; unattended agents build
  against `--mock` only.
- For step 6, write access to the production `model_enablement` table.

## 1. Verify the model on Bedrock (read-only)

Find the exact ids. Comparative declares the cross-region `us.` inference
profile, not the bare foundation-model id, so traffic can spread across
regions (the Claude entries do the same):

```bash
aws bedrock list-foundation-models --region us-east-1 --by-provider Amazon \
  --query "modelSummaries[?contains(modelId,'nova-pro')].[modelId,inferenceTypesSupported,inputModalities,responseStreamingSupported]"
aws bedrock list-inference-profiles --region us-east-1 \
  --query "inferenceProfileSummaries[?contains(inferenceProfileId,'nova-pro')].[inferenceProfileId,status]"
```

The foundation model must list `INFERENCE_PROFILE` (or `ON_DEMAND`) and the
profile must be `ACTIVE`. Some models have no `us.` profile at all
(`openai.gpt-oss-120b-1:0` is `ON_DEMAND` only): then `bedrockModelId` is the
bare foundation-model id, single-region, and the price is plain list with no
+10% premium — say so in the entry comment. Then prove model access with one
bounded call — an
`AccessDeniedException` here means model access is not enabled in the Bedrock
console (Rob), and nothing downstream will work:

```bash
aws bedrock-runtime converse --region us-east-1 \
  --model-id us.amazon.nova-pro-v1:0 \
  --messages '[{"role":"user","content":[{"text":"Reply with the single word ok"}]}]' \
  --inference-config '{"maxTokens":8}'
```

Record the `usage` block; it is your first cost datapoint.

## 2. Add the registry entry

Everything the product knows about a model lives in one object in
`packages/agent/src/models.ts`. Append the id to `MODEL_IDS` **last** —
registry order is the end-of-chain fallback order — and add the entry.
Field by field:

| Field | Where the value comes from |
| --- | --- |
| `bedrockModelId` | the `us.` inference-profile id from step 1 (the bare foundation-model id when no profile exists) |
| `provider` / `family` | lowercase vendor and family words (`amazon` / `nova`); the family word is what the identity evals forbid other vendors' turns from claiming |
| `displayName` / `brandedName` / `providerDisplayName` | the name users see, the exact name the assistant answers with when asked what it is, and the vendor's brand spelling (`Amazon`, `Anthropic`, `OpenAI`). The runtime identity line is built **only** from these — never write a vendor into prompt text (#304) |
| `olderModelExample` | optional; set it only when the family is known to misclaim an older version from training priors (Claude → "Claude 3.5") |
| `costPer1MInput` / `costPer1MOutput` | Bedrock list price **+10%** for `us.*` profiles (the account pays regional-endpoint rates); plain list for a bare on-demand id. Cite the pricing page in the entry comment; if you could not read it, say `UNVERIFIED — Rob to confirm` in the comment and the PR |
| `cacheReadInputMultiplier` / `cacheWriteInputMultiplier` | the model's cache-read / cache-write rates relative to input; moot when caching is off |
| `supportsPromptCaching` | `true` **only** if the model appears in the explicit `cachePoint` table of the [Bedrock prompt-caching guide](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html). Otherwise `false`: the loop then emits no checkpoints and the request stays valid. Nova is implicit-cache only |
| `supportsToolUse` / `supportsStreaming` / `supportsVision` | the model card / step 1 modalities |
| `invocation` | `converse` for this runbook. `responses` routes the model through Bedrock's OpenAI-compatible Responses API (`BedrockResponsesClient`, #660) — the OpenAI GPT entries use it; see "Responses-route models" below |
| `contextWindow` / `defaultMaxTokens` | the vendor's model-specification table. `defaultMaxTokens` is passed straight to Converse and must not exceed the documented output ceiling; note in the comment if it is below the 20–30k an artifact build needs (#320) |
| `blurb` / `recommendedFor` | selector copy; only shown once the model is enabled |

What updates itself from that one entry — no edit anywhere else:

- the identity line (`modelIdentityLine`) and the identity unit pins;
- `/model <id>`, `/model <display-name-slug>` and `/model <short-name>`
  aliases, and the Bedrock-id alias for `RUNTIME_V2_DIRECT_MODEL_ID`;
- cost accounting, budget receipts and the cost tripwires;
- the failover chain for every purpose the model is later enabled for;
- `/api/models`, the skill model picker and the admin surfaces (enablement-
  filtered, so nothing is visible yet);
- `pnpm eval --model <id>`.

Then run the free checks:

```bash
pnpm typecheck && pnpm test
pnpm eval --mock --model <id>     # proves the CLI path; can never qualify
```

One test **will** need a deliberate edit: `apps/web/__tests__/model-command.test.ts`
pins the complete `/model` alias table, so add the new model's two aliases
to the expected object. That is the only non-registry edit a new Converse
model needs today.

## 3. Read the identity guarantees before you spend money

Three layers say the assistant will never misstate what it is:

1. **Unit** — `packages/agent/src/model-identity.test.ts` pins that every
   registry id renders "You are powered by `<brandedName>`, made by
   `<providerDisplayName>`" and names no other registry model;
   `packages/agent/src/swappable-brain.test.ts` runs a full turn on the
   non-Claude entry through the real Converse request builder and checks the
   stable prompt carries that line and zero `cachePoint` blocks.
2. **Live** — the `model-identity` eval suite
   (`packages/evals/src/cases/model-identity.cases.ts`) asks the model what
   it is and derives the expected answer from the Bedrock id the loop
   actually sent: the family, display name and vendor must appear; no other
   registry model, other vendor family, or known older version may. It is
   CRITICAL, repeat-sampled 3×, and runs in every `pnpm eval`, `--core`, and
   `--model` run — so a candidate that introduces itself as Claude is
   `not-qualified` before anything else is read.
3. **Replay** — `pnpm transcripts:replay` fails a downloaded chat whose
   assistant label disagrees with the model it claims to be.

If the new model fails layer 2, do not tune the prompt for it in a skill or
context pack (that is the #304 ban); fix the registry fields or file the
issue.

## 4. Get a baseline

The scorecard's known-red parity and cost checks need the incumbent's latest
**real** report. Download the newest nightly artifact:

```bash
run_id="$(gh run list --workflow nightly-evals.yml --status success --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run download "$run_id" --name eval-report --dir packages/evals/eval-reports/nightly
ls packages/evals/eval-reports/nightly/*.json
```

If the newest green nightly is older than a week, rerun the incumbent first.

## 5. Qualify

```bash
AWS_REGION=us-east-1 BEDROCK_CLIENT=real pnpm eval --model <id> \
  --baseline packages/evals/eval-reports/nightly/<stamp>.json
```

The header must show the candidate as `<id>` and the judge as
`JUDGE_MODEL_ID` (pinned; the CLI refuses `--model <judge>`). Read the
scorecard at the end against the bar in
[`docs/REGRESSION_GAUNTLET.md`](../REGRESSION_GAUNTLET.md#model-qualification):
every check ✅ is `QUALIFIED`; any ❌ is `NOT QUALIFIED`; a ➖ is
`INCOMPLETE` and usually means no baseline. MEDIUM/LOW misses do not block
but each gets an issue before the flip. Paste the scorecard verbatim in the PR
that adds the entry; the report files are gitignored.

Budget: if the full pack would exceed roughly 45 minutes or $10 for this
model, run `model-identity` plus a representative slice and say exactly what
was skipped.

## 6. Flip enablement rows (Rob)

There is no admin UI for this yet (#302); the path is SQL against the
production database, reached the way
[`RDS_NETWORK_PERIMETER.md`](./RDS_NETWORK_PERIMETER.md) describes, with the
`DATABASE_URL` from the `ai-workspace/production/app` secret. Rows are per
`(model_id, purpose)`; `purpose` is one of `chat`, `fast-local`,
`tool-local`, `durable-local`, `summaries`, `routing`, `memory-capture`
(`MODEL_PURPOSES` in `models.ts`). Enable only the purposes the scorecard
covered — a chat brain does not become the judge, summarizer or memory
reviewer by accident, because each of those resolves against its own rows:

```sql
INSERT INTO model_enablement (model_id, purpose, enabled)
VALUES ('nova-pro', 'chat', true)
ON CONFLICT (model_id, purpose)
DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now();
```

The lookup cache is 30 seconds; no redeploy. Rollback is the same statement
with `false`. Two traps:

- **While `PLATFORM_MODEL_OVERRIDE_ID` is set** (`models.ts`, the temporary
  Sonnet 4.5 pin) every purpose resolves to the pinned model and rows are
  inert. Lifting the pin is a code change and a product decision, not part
  of this runbook.
- **Absence of a row is "disabled"; a DB error is "fail open to the whole
  registry".** If the table is unreachable the new model is selectable
  everywhere. Check `[model-enablement-load-error]` in the logs before
  trusting an enablement state.

## 7. Failover (optional, automatic)

Enabling a model for a purpose appends it to that purpose's failover chain
in the registry's cost/capability order (`orderModelCandidatesForPurpose`).
Cross-provider hops are allowed only onto models with a row for that purpose
(`resolveModelFailoverChain`, #797 P3): today the enablement row is the
qualification record, since no scorecard verdict is persisted. There is no
way to enable a model for chat and keep it *out* of chat failover; if that
is wanted it is a new column, not a runbook step.

## 8. Nightly (Rob, IAM)

The nightly eval role (`infra/cdk/lib/ai-workspace-eval-ci-stack.ts`,
`EVAL_INFERENCE_PROFILES` / `EVAL_FOUNDATION_MODELS`) can invoke only the
named Claude ARNs. A nightly case on the new model needs its profile and
foundation-model ids added there and the stack redeployed
(`docs/EVAL_AUTOMATION_SETUP.md`). Until then the `model-identity` suite runs
nightly on the incumbent only; a per-enabled-model fan-out is designed but
not built (see the #797 P3 PR).

## Responses-route models (`invocation: "responses"`, #660)

The OpenAI GPT models on Bedrock are not reachable through Converse on the
`bedrock-runtime` endpoint; their registry entries declare
`invocation: "responses"` and `RealBedrockClient` sends them through
`BedrockResponsesClient` (`packages/agent/src/responses-client.ts`) —
Bedrock's OpenAI-compatible Responses API at
`https://bedrock-runtime.<region>.amazonaws.com/openai/v1/responses`, SigV4-
signed with the ambient AWS credentials, `store: false` on every request,
client-side function calling only. Everything above still applies; the
differences:

- **Step 1.** The model card's "Programmatic Access" table gives the `us.`
  geo profile to declare (`us.openai.gpt-5.6-terra`); in-Region ids are
  Mantle-only. The bounded access probe is a signed HTTPS call, not
  `aws bedrock-runtime converse` — the quickest is a one-off `tsx` script
  that runs `runAgentLoop` on the entry with `BEDROCK_CLIENT=real` (the P4
  PR body has one).
- **Pricing.** The card's own pricing table is authoritative and already
  regional (use the "Geo CRIS, Short Context" row as-is — no +10% on top).
  Input beyond 272K tokens bills a 2× "Long Context" tier the registry does
  not model; declare `contextWindow: 272_000`.
- **`supportsPromptCaching`** stays `false`: the flag gates Converse
  `cachePoint` blocks and the Responses client sends no explicit cache
  markers. Implicit caching still applies; `cached_tokens` are reported as
  cache reads.
- **IAM.** Production needs no new action: the task role's
  `bedrock:InvokeModel*` on `*` covers the inference profile, the foundation
  models it routes to, and the `bedrock:InvokeModel` on
  `arn:aws:bedrock:<region>:<account>:project/default` the Responses API
  additionally authorizes. A least-privilege role must list all three. The
  nightly role (step 8) needs the profile, the foundation-model ARNs, and
  the default-project ARN.
- **Qualification** is the same `pnpm eval --model <id>` command; the
  harness needs no wiring because the dispatch is inside the client the
  judge shares (the judge stays on Converse).

## Honest accounting

Rehearsed on `nova-pro` (2026-09-05): steps 1–2 took about 20 minutes, the
mock and unit checks 10, and the full 146-case pack ran unattended for about
16 minutes at $1.28 ($0.63 candidate + $0.65 judge) — verdict NOT QUALIFIED,
on the injection spine. That is inside the hour for the developer's own time. "Zero code changes beyond the
registry entry" holds for production code; you will still edit one test
pin (the `/model` alias table), and whether the new model does anything at
all in production depends on the platform pin and on Rob's rows.

Rehearsed again on `gpt-oss-120b` (2026-09-06, Haiku judge, `--baseline` =
that morning's nightly): the full 147-case pack ran unattended in 17 minutes
at $0.38 ($0.13 candidate + $0.25 judge) — verdict NOT QUALIFIED (119/147; 19
CRITICAL, 9 HIGH misses, one known-red not red on the incumbent). Same
shape as Nova: identity 3/3 and the cost tripwire pass, the injection spine
does not.
