# Runtime compatibility regression check (#921)

Tested from `goal/921-provider-output`, based on `13beeb02`, on 2026-09-07.
This is a runtime regression check, not model qualification or enablement.
The production model pin and all enablement rows are unchanged.

## Boundary contract

- A Converse request with historical tool blocks carries tool schemas even
  when no tools are mounted. Historical schemas are explicitly unavailable
  for execution. Registry membership alone no longer authorizes a call;
  the tool must also be mounted in that iteration. Synthesis-only steps
  still refuse all tool execution.
- For non-Anthropic models, text-embedded `thinking`, `think`, `reasoning`,
  and DeepSeek DSML function-call blocks are withheld before visible events
  and continuation history. Partial stream markers never flash into the UI.
  Inline/fenced code containing literal tags and ordinary HTML are retained.
  Existing structured reasoning events and signed blocks are unchanged.
- Leading whitespace is removed at the start of the answer for every model.
  Internal/trailing whitespace and separators after tool calls are retained.
- A markup-only response fails visibly instead of silently succeeding with
  an empty answer. DSML text is not interpreted as authorization to execute
  a tool. This is not a general tool-protocol adapter.

Converse requires at least one entry in `toolConfig.tools` and offers no
`none` tool-choice mode. The runtime execution guard remains authoritative,
not the schema description. See the AWS
[ToolConfiguration API](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolConfiguration.html)
and [ToolChoice API](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolChoice.html).

## Live results

For each model below, ran `provider-compatibility`, `exact-output`, and
`tool-evidence-continuity` via:

```sh
AWS_REGION=us-east-1 BEDROCK_CLIENT=real pnpm --filter @ai-workspace/evals exec tsx src/run.ts <suite> --model <model>
```

Judge stayed `haiku-4-5`. No existing assertion, rubric, or known-issue marker
was changed. Counts below are case counts; the existing benign echo case
also runs three independent samples.

| Model | Compatibility | Exact output | Tool continuity | Runtime errors | Protocol leaks / leading whitespace |
| --- | --- | --- | --- | --- | --- |
| kimi-k2-5 | 3/3 | 9/11 | 4/4 | 0 | 0 / 0 |
| deepseek-v3-2 | 3/3 | 10/11 | 4/4 | 0 | 0 / 0 |
| gpt-oss-120b | 3/3 | 11/11 | 4/4 | 0 | 0 / 0 |
| sonnet-4-5 | 3/3 | 11/11 | 4/4 | 0 | 0 / 0 |

The exact-output failures remain real failures, not excused markers:

- DeepSeek and Kimi: `approved-memory-exact-prose` used the combined
  memory sentence rather than the expected two short sentences. The input
  asks for "the pilot sentence" while memory contains a combined sentence;
  fixture intent is a separate #922 review, not changed here.
- Kimi: `approved-memory-exact-json` wrapped the requested inline JSON in a
  code fence. This is a genuine output-contract miss; stripping all code
  fences to make it pass would corrupt other valid outputs.

Neither candidate is qualified by these focused runs. Sonnet's affected
suite baseline is green; a full future nightly is still the broader check.

Raw JSON/Markdown reports are preserved locally under
`packages/evals/eval-reports/` with these UTC run identifiers:

| Model | Compatibility | Exact output | Tool continuity |
| --- | --- | --- | --- |
| Kimi | 2026-09-07T03-36-38-507Z | 2026-09-07T03-39-14-716Z | 2026-09-07T03-39-32-348Z |
| DeepSeek | 2026-09-07T03-37-17-115Z | 2026-09-07T03-37-36-025Z | 2026-09-07T03-37-50-837Z |
| GPT-OSS | 2026-09-07T03-37-53-086Z | 2026-09-07T03-38-07-179Z | 2026-09-07T03-38-18-634Z |
| Sonnet | 2026-09-07T03-38-23-724Z | 2026-09-07T03-38-46-160Z | 2026-09-07T03-39-04-338Z |
