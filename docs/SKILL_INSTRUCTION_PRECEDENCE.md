# Skill Instruction Precedence

Implementation for #925 / #438 P1 shipped in #952 as `47f2ef3`. Production
deployment and authenticated smoke were verified 2026-09-10 01:11Z. Approval:
Rob accepted the nullable standing-notes migration and released the PR hold;
the scope and exact quote are recorded on #925.

## Runtime contract

The shared instruction order is governance > organization > skill standing
notes > active skill instructions > personal preferences and approved Vault
memory > conversation history. Team guidance (P2) remains deferred behind
#413's identity substrate. No layer can grant permissions, change model identity,
bypass approvals or reinterpret protected platform rules.

Chat activation, saved-skill Run now, scheduled runs and GitHub event runs all
carry the operating instructions in the stable system prefix. Scheduled/event
enqueue snapshots the authorized skill's prompt and notes in `activeSkillPrompt`;
retries use that snapshot. Later unrelated turns do not inherit it. A subsequent
activation reads the current skill row. Previously queued legacy runs retain
their old materialized prompt; this change does not rewrite historical runs.

The model-visible user message contains the execution request, not the skill
body. GitHub event data retains its existing nonce-framed untrusted-data boundary.
Existing execution budgets, provider authorization and unattended autonomy presets
remain unchanged. Framing prose never substitutes for the server's gates.

## Standing notes and receipts

Migration `0052_skill_standing_notes` adds one nullable text column. Null/blank
means no notes: no placeholder notes are inserted. P1 consumes this field as a
read-only layer; it does not add automatic accumulation, a notes editor, import
support, or a model-accessible notes-write tool. Those require the separate
skills-governance/accumulation design (#412).

Notes use deterministic reserved-marker encoding, below organization policy and
before the operating instructions. Changes rotate the prefix hash. Receipts
name notes and activation source, reporting character counts rather than note
contents. Historical receipts retain their original precedence chain.

Settings > Instructions explains the same chain for interactive and unattended
runs. It does not promise the deferred team layer or new authoring controls.

## Validation and deployment

- Local lint, typecheck, full unit suite and production build passed. Browser
  smoke: 300 passed, 52 skipped; real-Postgres integration: 68 passed. The
  three build-dependent client-bundle scans also passed after the build.
- Unit coverage: enqueue snapshot, hidden message boundary, worker propagation,
  notes ordering, marker escape, receipt parsing and prefix-hash rotation.
- Real-Postgres schedule Run now covers migration-backed notes and unchanged
  unattended autonomy; browser coverage checks the Settings explainer.
- Real Sonnet 4.5 shared-layer evaluation: interactive, scheduled and GitHub
  event variants each passed 5/5 with the unchanged deterministic three-bullet
  and sentinel assertions. This is model-framing evidence, not a claim that the
  evaluator drove a live production scheduler. Raw report is preserved at
  `~/code/comparative-worktree-audit/925-precedence-live.json`.
- Exact-head CI/Product Smoke and independent Claude review passed before merge.
  Snapshot `pre-migrate-0052-20260910t003953z` was available before merging.
  CodeBuild `73b4a4e0-d8d5-4bb9-b864-fddc079c9ae6` succeeded for the merged SHA;
  migrator task `7e0179feefac40268af115f15222daed` and authenticated smoke task
  `7e8f03bfe8ba4cc98af3791f91cda94b` both exited 0. No production notes were
  seeded. Full receipt is on #925 and #952.
