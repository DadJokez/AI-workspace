# Build Queue — re-triaged 2026-09-07 (written 01:28Z)

Prioritized, dependency-ordered queue of open work, rewritten at the end of
the 2026-09-05/06 delegated session so the next agent starts from one page.
Everything here is verifiable from `gh`, `aws` (account 351478076796,
us-east-1) and `git log origin/main --since=2026-09-05`. The session handoff
with the mechanics (how to merge under delegation, migrations, one-off in-VPC
work) is issue #926; this file is the order, not the manual.

**Consumed by `/goal`** (`.claude/commands/goal.md`): an unattended session
works this queue top-down, skipping anything whose dependencies aren't merged
to `main` or that is Rob-gated. Re-triage when this file is more than ~2 weeks
old or the queue is empty — next check-in 2026-09-21.

## State on 2026-09-07 01:28Z

- **`main` is `39fa562` (#927) and deployed** — CodeBuild `ai-workspace-build`
  SUCCEEDED for that SHA at 00:34Z. No open PRs.
- **Migration stack shipped and applied in prod:** 0049 (#872 generic
  read-tool bindings), 0050 (#870 least-privilege proxy DB role), 0051 (#905
  `org_instructions`). Each has a manual RDS snapshot (`pre-migrate-00nn-…`),
  a migrator receipt and a smoke receipt. RDS `DeletionProtection` is ON.
- **Merge gate:** `needs-rob` is live and sticky (#900); reviewer applies it
  before posting, only a human release counts. **The Merge Gate Audit has a
  false positive (#928):** it matches "human-owned under" on a review's first
  line even when negated, and filed #914/#916 for two clean merges.
- **Evals:** judge `haiku-4-5` (#907); rubrics name FAIL conditions and the
  judge sees tool receipts on write-boundary cases (#915); `judge-replay.ts`
  + 22 pinned controls are the validation bar for any rubric change. Nightly
  2026-09-06 (#910) was red on three cases that #913 and #915 fixed *after*
  it ran; the 2026-09-07 nightly (~11:30Z) is the first read of the fixes.
- **Models:** 19 registry entries, 15 disabled; every scored non-Claude model
  is NOT QUALIFIED (GLM-5 best, 135/147) — `docs/models/QUALIFICATION_*.md`.
  The six frontier entries (GPT-5.6 Terra/Sol/Luna, Sonnet 5, Opus 5,
  Fable 5.1) refuse at the Bedrock data plane despite ACTIVE agreements;
  **AWS Support case 178874379300896** (opened by Rob 2026-09-07) is the
  only path — see #920. Nothing is enabled; `PLATFORM_MODEL_OVERRIDE_ID`
  still pins `sonnet-4-5`.

## Triage principles this cycle

1. **Gate integrity first.** A merge-audit that cries wolf trains everyone
   to ignore it; #928 is the first item and #914/#916 stay open until the
   audit re-runs green.
2. **Read the canary before building on it.** #910 is judged by the
   2026-09-07 nightly, not by hand; no markers, no rubric edits outside the
   #915 validation bar.
3. **Security spine, one per cycle:** #906 (enablement lookup fails open).
4. **The model tranche rides while #920 waits on AWS.** #921/#922/#923 are
   harness and runtime work that needs no new model access.
5. **The strategic swing (#801) is unblocked** — #872 is on `main`, so
   Tier C resumes at #803, with its §7 caveats intact.
6. **Rails before reach:** #924 (R1 snapshot-in-build, R6 never silently
   undeployed) before the deploy pipeline gets busier.
7. **Migrations merge in journal order and only Rob merges them** (or an
   explicit chat delegation, quoted verbatim on the PR). Journal `when` must
   increase with idx.

## Work order for the next session (skip anything Rob-gated)

1. **#928 — merge-audit false positive (S).** Edit step 2c of
   `scripts/verify-pr-gate.sh` to ignore negated "human-owned under"; add
   the two real first lines (#913, #915) as fixtures that must PASS and the
   #885 text as one that must FAIL. Gate-script change → the reviewer will
   apply `needs-rob`; Rob releases. Afterwards re-run the audit for
   `e747de6b` and `a14c0b34`; Rob closes #914/#916 with the green runs.
2. **#910 — read the 2026-09-07 nightly.** Green → close #910 with the run
   link. Red → per-case triage in a comment (which suite, judge or
   deterministic, same failure as 09-06 or new); rubric changes only via
   `judge-replay.ts` ×2 judges + controls + live 5/5.
3. **#906 — fail-closed model-enablement lookup (S; security spine).**
   No §7 surface.
4. **#921 — runtime fixes for non-Claude brains (H).** Always send
   `toolConfig` with tool-bearing history; strip provider reasoning/markup
   from visible output; trim the leading space. Product loop change → eval
   cases required (`docs/REGRESSION_GAUNTLET.md`).
5. **#922 — level the eval field (M).** Meaning-based deterministic checks,
   Unicode-normalised exact facts, the thread-summary precedence case. Must
   not change any verdict on the pinned controls without saying so.
6. **#923 — GLM-5 for the routing purpose (M).** Repeat-sampled run, then
   Rob decides the `model_enablement` row — never write it unattended.
7. **#925 — #438 P1 (M).** Precedence contract for scheduled/triggered
   skill runs + per-skill standing notes; Settings explainer copy.
8. **#924 — deploy rails R1 + R6 (M).** Pre-migrate RDS snapshot inside the
   build and a never-silently-undeployed retrigger. Pipeline + IAM →
   describe the IAM delta at the top of the PR body; Rob releases.
9. **Tier C — #803 → #804 → #805 → #806**, now unblocked. Caveats stand:
   the live-via-viewer default flip (#803) and anything that *blocks* data
   leaving a thread (#804) are DESCRIBED in the PR body for Rob, built
   behind an off-by-default flag, never flipped unattended; #805 is
   presentation and API shape only.
10. **#776 — credential-injection egress proxy (L)**, unblocked by #870.
11. **Tier D — #772 checkpoints → #774 verifier → #773 delegated-approval
    half**, unblocked by #882.
12. **#823 leftovers (S, `needs-rob`)** — Node 20 warning on
    `github-script`; fail-closed test for the account allow-list.

Two well-tested PRs beat four thin ones; when context runs low, stop and
write the summary.

## Waiting on AWS (not queue work)

- **#920 — frontier model access.** Case 178874379300896. When any of the
  six answers a probe, run the packs in this order with these cost caps:
  Terra $6, Sol $6, Luna $6, Sonnet 5 $6, Opus 5 $10, Fable 5.1 $6
  (`BEDROCK_CLIENT=real pnpm --filter @ai-workspace/evals exec tsx
  src/run.ts --model <id>`; judge stays `haiku-4-5`). Baseline is the
  2026-09-06 nightly artifact. Fable 5.1 also needs the `aws_review`
  data-retention opt-in and a per-model sampling exception (temperature
  must be unset).
- **#660** closes with Terra's scorecard; the adapter itself shipped in #917.

## Rob decisions (skip during unattended work)

- Close #914 and #916 once #928 lands and the audit re-runs green.
- #920 support case follow-through; if AWS asks for the use-case form
  again, the real text is on #920 (the account's stored form is a
  placeholder that `PutUseCaseForModelAccess` will not replace).
- `model_enablement` rows — #923 proposes GLM-5 for routing only.
- Six UNVERIFIED prices in `packages/agent/src/models.ts`.
- `PLATFORM_MODEL_OVERRIDE_ID` (#880 option 2): lift only after a model is
  enabled per purpose.
- **#893 — one live run per thread/schedule** (migration: unique partial
  index + claim fence). Rob merges; buildable as a PR with the migration
  flagged at the top.
- `#847` markers — lift when three green nightlies include those cases.
- #696 production load run; #697 staging; #455 key split; #692
  provider-side revocation; #706 quota isolation; #691 WAF block mode.
- Migrations without a driver: #396 cache-token columns, #423 runs tree,
  #599 FK rename — batch with the next Rob-merged migration.
- **Close-as-superseded candidates (Rob's call):** #301 (qualification
  pipeline → #879 `pnpm eval --model` + #919 scorecards), #302 (admin model
  page → `model_enablement` + `docs/models/`), #305 (first cheap-lane
  models → the 2026-09-06 gaggle). Each still holds one unmet line item;
  either close with a pointer or re-scope to that item.

## Deliberately parked (do not start without a conscious call)

- #736 Governed Custom Agents (+#745–#748) — after Tier C is underway.
- #811 Studio Browser general navigation + persistent sessions.
- #491–#493 perimeter/identity/accountable-runtime epics — pull items only
  when an IT-review date makes them concrete.
- #494 / #495 / #78 — habit loop, flywheel, share cards.
- #765 unified shell, #769 Button migration — after Tier B polish settles.
- #620 / #622 / #624 / #435 / #734 — proposal inbox, provenance shell,
  Salesforce writes, spend dashboard.
- #412 / #413 / #422 / #424 — GA-Pac architecture specs; #413 gates #438 P2.
- #744, #467, #460, #381, #777, #778, #779, #780 (remaining item 2c),
  #775, #808, #810 (decision ticket), #836 — later, unchanged.

## Notes

- The `.claude/commands/goal.md` guard "Do not touch PR #272 or issue #291
  (SES)" stays: production email path, Rob's under §7.
- Every comment posted via Rob's token starts with "Posted by Claude Code via
  Rob's token —"; timestamps come from `date -u`, never from memory.
- Lane worktrees under `.claude/worktrees/` are disposable; a branch checked
  out in an old worktree makes `git worktree add` fail — reuse it with
  `git fetch` + `git merge --ff-only`, and never git-touch the main checkout.
- The 2026-09-05 queue (34 PRs in two days, full tier history) is in git
  history at `0d56d73..39fa562`; this file intentionally starts over.
