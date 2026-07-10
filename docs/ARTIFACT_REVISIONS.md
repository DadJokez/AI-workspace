# Artifact Revision Invariants

This document is the contract for revising Workspace artifacts. It is the
tiebreaker when chat context, persistence, and UI code disagree about which
artifact a turn should update. App versions use different tables and are not
covered here.

## Terms

- **Artifact version**: one immutable `workspace_artifacts` row.
- **Version group**: every row with the same `artifactGroupId`. A group is the
  durable identity of one logical user-visible file.
- **Visible original**: the canonical artifact shown in chat and the Artifacts
  menu. It keeps the group's original display filename and resolves to the
  highest `versionNumber` in the group.
- **Revision target**: the exact version/group selected as the source of an
  ordinary edit. It is stored in run inputs so retries and worker handoffs do
  not have to guess again.
- **Separate source**: an artifact used as input to an explicit copy, fork,
  alternate, or separately named version. It must not be mutated.

## State Transitions

| User intent | Group | Version | Visible filename | Supersedes |
| --- | --- | --- | --- | --- |
| New file with no matched target | New group | `1` | Emitted filename | `null` |
| Ordinary edit of a matched artifact | Existing target group | Prior + 1 | Visible original filename | Latest prior version |
| Ordinary edit with a compatible generic filename such as `updated.html` | Existing target group | Prior + 1 | Visible original filename | Latest prior version |
| Explicit copy/fork/alternate | New group | `1` | Explicit distinct name, otherwise a collision-free `-copy` name | `null` |
| Incompatible emitted file type | New group | `1` | Emitted filename | `null` |

Every persisted version is immutable. "Edit in place" describes the visible
experience, not a database update. Prior versions remain available for audit,
rollback, comparison, and historical downloads.

## Target Selection

1. Artifact lookup is always scoped to the current user.
2. A confidently named artifact wins. Otherwise, a revision in a thread may
   use that thread's newest compatible artifact.
3. Reopening an old thread must load that thread's artifacts even when they
   fall outside the global recent-artifact window.
4. Cross-thread implicit matching is conservative: one compatible candidate
   may match; ambiguity produces a clarification request, never a guess.
5. A stored revision/separate target is the durable fallback for retry,
   resume, and worker handoff. Rebuilt manifest-only context must not erase it.
6. A new confident match may replace a stored target. Revision and separate
   targets are mutually exclusive for one turn.
7. If matched content cannot be loaded, no revision version is created from
   memory. The user gets a recoverable error or clarification.

## Persistence And Failure

- Only a successful assistant turn with a complete, accepted artifact payload
  may create a version row.
- Canceled, failed, or truncated output never advances a version group.
- Interrupted artifact-like snippets are collapsed behind an actionable retry
  message instead of appearing as a tiny or apparently saved document.
- A Markdown/HTML artifact response renders as a bounded document affordance
  plus an artifact pill; raw source does not become ordinary assistant prose.

## Visible UI

- Chat and the Artifacts menu show one canonical item per version group by
  default.
- The canonical pill and download use the visible original filename for normal
  edits; routine revisions do not add `-v2`/`-v3` to that filename.
- An open preview follows the newest persisted version in the same group.
- Historical versions remain discoverable from version history but do not
  crowd the normal chat or artifact list.
- Explicit copies/forks are separate visible items with separate groups.

## Ownership Boundaries

- `artifact-context.ts` interprets the user message, selects a user-scoped
  candidate, and loads content for the model.
- `artifact-revisions.ts` is the single owner of durable target resolution and
  version-group state transitions.
- `workspace-artifacts.ts` parses assistant output and performs scoped database
  reads/inserts using the revision plan.
- Chat runners carry the resolved target through run inputs and persistence;
  they do not reimplement target selection.
- UI components render persisted summaries and choose the latest version; they
  do not decide group membership.

## Historical Characterization

- **#242**: generated Markdown collapses into a document/artifact affordance
  instead of dumping raw source into chat.
- **#244**: interruption/retry preserves the stored revision target and does
  not persist a partial version.
- **#256**: a vague current-thread HTML edit targets the existing group and an
  open preview advances to the new version.
- **#276**: ordinary edits keep the visible original while explicit copies and
  forks create a separate group.
- **#284**: reopening an old chat retains its artifact target and a successful
  follow-up produces the intended next version instead of stalling.
