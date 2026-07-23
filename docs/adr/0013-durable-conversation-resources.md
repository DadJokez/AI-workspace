# ADR 0013: Uploaded files are durable, thread-scoped conversation resources

- **Status:** Accepted
- **Date:** 2026-07-22
- **Deciders:** Rob (owner), Codex (implementation)
- **Related:** [#575](https://github.com/DadJokez/AI-workspace/issues/575), [#576](https://github.com/DadJokez/AI-workspace/issues/576), [ADR 0001](./0001-context-knowledge-management.md)

## Context

An uploaded file used to reach the model as a bounded extract on its upload
turn. A later reference such as "continue analyzing it" either lost the file or
replayed the latest upload's bounded extract into the prompt. That behavior
mixed up three different facts:

1. a file exists in this conversation;
2. a preview of that file was injected into one prompt;
3. the complete source was actually inspected.

It also made multiple-file selection nondeterministic, repeatedly spent prompt
tokens on large previews, and could not carry native images or complete-file
access across refreshes, retries, or the inline/AgentCore boundary.

## Decision

Treat each `workspace_artifacts` row with `source=user-upload` as the initial
storage backing for a typed, thread-scoped conversation resource.

- The artifact UUID is the stable resource id. Metadata records one upload
  batch id, a SHA-256 checksum, lifecycle state, and available representations.
  Every load is scoped by authenticated user id, thread id, resource id, and
  `source=user-upload`.
- Resolve references deterministically in this order: current upload, exact
  filename (then an unambiguous stem), prior run receipt, sole active thread
  resource, otherwise clarification. Never infer "newest file."
- Persist compact resource resolution receipts in `runs.inputs`, context
  receipts, and run events. Receipts carry ids, representation, resolver
  reason, and full/partial coverage, not file bytes or extracted content.
- Fold a bounded extract only on the current upload turn. Later turns receive a
  compact manifest and use a first-party, read-only `resources__query` MCP
  capability.
- The resource MCP mount is signed per run, expires, authorizes at most the
  selected resource ids, and is separate from sticky account-tool activation.
  The endpoint rechecks user/thread/source ownership before every read.
- CSV, TSV, and XLSX operations parse the original stored source and scan every
  row for schema, count, aggregate, filter, sort, and sample operations. PDF,
  DOCX, PPTX, and text expose addressable sections with provenance. Images
  restore the authorized original bytes as native multimodal input on later
  turns.
- Model-visible file/tool content remains untrusted data and is nonce-framed.
  Persisted tool state keeps compact receipts only. A comprehensive claim is
  allowed only when the tool receipt says `sourceCoverage=full`.
- Deleting the backing artifact revokes the resource immediately. No separate
  registry table or content copy is introduced in this phase.

## Consequences

**Positive**

- A chat remains one continuous working conversation across refresh, retry,
  resume, edit/replay, inline execution, and AgentCore execution.
- Complete-file claims are tied to deterministic evidence rather than a
  truncated prompt preview.
- Large files stop consuming prompt tokens on every related follow-up.
- Existing artifact ownership and deletion semantics remain the authorization
  source of truth; there is no second ACL or shadow content store.
- The same resource capability works on both execution lanes through the
  shared turn executor.

**Negative / risks**

- Complete-file adapters parse original files on demand. This is appropriate
  for the current 10 MiB upload limit but spends worker CPU and memory again on
  repeated queries.
- Addressable document search is lexical and in-process. It is not a general
  corpus search system and does not replace project-level retrieval.
- The first-party MCP route depends on the existing OAuth encryption key for
  request signing. A missing key makes resource tooling unavailable rather
  than falling back to an unsafe unsigned path.
- Model behavior still needs a deployed authenticated probe in addition to
  deterministic adapter tests; the release gate therefore has an explicit
  resource-matrix mode.

## Alternatives considered

- **Replay the latest extracted preview.** Rejected: ambiguous with multiple
  files, expensive on every turn, and cannot prove complete analysis.
- **Put every original file in every prompt.** Rejected: wasteful, exceeds
  model/runtime limits, and unnecessarily broadens exposure.
- **Create a new resource table and chunk index now.** Deferred: the existing
  artifact row already supplies durable storage, ownership, thread scope, and
  deletion. A second persistence model is not needed at the current scale.
- **Use a vector database for conversation uploads.** Rejected for this scope:
  exact table operations and addressable source reads are deterministic and
  preserve provenance. ADR 0001 still governs corpus-scale retrieval.

## Revisit when

Revisit the storage/index choice when files exceed the current upload limit,
repeated parse cost is material, a thread regularly contains more than five
active resources, or project reference collections require cross-document
semantic retrieval. Any later index must preserve the resource id, source
provenance, owner/thread authorization, deletion behavior, and honest coverage
receipt defined here.
