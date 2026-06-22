# CreateHarness examples — validation notes

Three planned use cases as `CreateHarness` request bodies. **Illustrative placeholders** (ARNs,
buckets, KB) — not deployable as-is. Validate before use.

## Validated against the fetched `CreateHarness` field list
- `harnessName` matches `[a-zA-Z][a-zA-Z0-9_]{0,39}` → **underscores, not hyphens** (the filenames use
  hyphens for readability; the `harnessName` inside each file uses underscores).
- `executionRoleArn` is present (the only **required** field) and points at the per-harness roles in
  [../iam-and-execution-roles.md](../iam-and-execution-roles.md).
- `model`, `memory` are **union** objects — exactly one member set (`bedrock`, and `managed`/`disabled`).
- `skills[]` entries are `HarnessSkill` **union** members (`s3`, `awsSkills`).
- `systemPrompt[]` is an array of content blocks (`[{ "text": ... }]`).
- `allowedTools[]` uses the glob grammar (`@builtin`, `@server/tool`, `@server/*`).

## Known discrepancy (flagged for verification)
The GA blog and the mission prompt write `awsSkills: {}` as a **top-level** harness toggle. The
`CreateHarness` API reference shows skills only as `skills[]` of `HarnessSkill` union objects whose
source is `awsSkills | git | s3 | path`. These examples follow the **API** shape
(`"skills":[{ "awsSkills": {} }]`). Confirm in the console/SDK before building.

## Fields to confirm against the live API (not fully specified in the fetched docs)
- `truncation.strategy` enum values (we use `DROP_OLDEST` + `config.preserveSystemPrompt` as a
  placeholder) — verify the real enum.
- Exact nested shape of `tools[].config` per type (`agentcore_gateway`, `agentcore_code_interpreter`)
  and of `memory.managed` strategy names.
- `model.bedrock` member key (`modelId`) and whether inference-profile ARNs vs IDs are accepted.

## Per-file intent
| File | Use case | Notable choices |
|---|---|---|
| `marketing-analytics-agent.json` | Databricks → Code Interpreter → chart | Sonnet; Gateway + code interpreter; managed memory; marketing+analytics S3 skills |
| `internal-docs-q-and-a-agent.json` | KB-backed internal-docs Q&A | **Haiku** (cheap, high volume); KB target is **planned** (RAG deferred — ADR 0001) |
| `aws-ops-agent.json` | AWS ops "data + analytics" pattern | `awsSkills: {}`; **memory disabled**; read-only IAM is the real boundary |
