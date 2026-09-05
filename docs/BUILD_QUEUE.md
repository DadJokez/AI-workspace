# Build Queue — re-triaged 2026-09-05 (written 20:56Z, reconciled 21:59Z)

Prioritized, dependency-ordered queue of open work. Re-triaged three days after
the 2026-09-02 queue because that file's state moved faster than its header:
its Tier 0 cleared (bar the Rob decisions), every Tier A and Tier B item is
closed, #797 P1–P3 + P5 and #438 P0 are built, and two sessions — the
2026-09-03/04 overnight and the 2026-09-05 day — merged 34 PRs between
2026-09-04 00:00Z and 20:38Z today (`git log origin/main --since=2026-09-04`).
`main` is at `0d56d73` (PR #902). What is left is a Rob-gated migration stack
(#872 → #870 → #905), three of the day's four gate PRs merged by 21:35Z (#901, #903, #907), with #909 (#696 pilot load harness) merged 21:53Z and #904 plus #908 (this re-triage) still in the gate, one new
security item (#906), and the rails the 2026-09-04 audit asked for.

**Consumed by `/goal`** (`.claude/commands/goal.md`): an overnight session works
this queue top-down, skipping anything whose dependencies aren't merged to
`main` or that is human-gated. Re-triage when this file is more than ~2 weeks
old or the queue is empty (goal.md Phase 2.1) — next check-in 2026-09-19.

## Completed since the 2026-09-02 triage

- **Tier 0 — cleared.** #845 CVE gate → #852 + #863; #847 anti-echo flakes →
  #857 (issue closed by the merge; its three assertion-scoped markers stay on
  `main` until the rejoin bar is met — see Tier 0 below); #701 write boundary
  → #861; #846 scoping guard → #858; #848 budget truncation → #859; #850
  ADR-0011 → #854; PR #798 identity seam. Then, 2026-09-05: #862 concurrency
  by head SHA → #899; #898 migration safety (lock/statement timeouts on the
  migrator + additive-only guard in CI) → #902; #895 judge truncation → #897
  (which also fixed #704, closed 2026-09-05). **#830 (the nightly alert
  thread) closed 2026-09-05 19:54Z on three consecutive green scheduled
  nightlies** (09-03 142/0; 09-04 re-run 144/0/1 known-red; 09-05 10:58Z
  green on `2f6037b`). #675 closed the same hour: its bar was met (85/85
  samples per case over 17 nightlies) and #857 had already removed both
  markers.
- **CI reliability:** job caps #864 / #878 / #881; bounded advisory-registry
  attempts #876 (#875); daily production dependency audit #855 (#853); smoke
  settle #874 (#813); docs-only fast lane #877 (#812; this file's updates
  #884 / #896 and this one are its proofs); CI Postgres from the runner
  image #883 → #889 (#708, #887); unit coverage #869 (#695). Rob's standing §7
  delegations (security-patch pins, tightening-only enforcement) recorded in
  `CLAUDE.md` by #865. #885 (#823 action pins) merged 2026-09-04 11:06Z —
  ruled §7 by the review 37 s later; its revert #890 is held (Parked list).
- **Tier E (#797) — P1, P2, P3 and P5 built.** P1 seams #871 + #798 + #888
  (#856); P2 qualification harness #879; **P3 + P5 in PR #904 (opened
  2026-09-05 20:47Z, in the gate):** Nova Pro registered `disabled`, failover
  policy, exit test on the real entry, live access proof, the runbook
  `docs/runbooks/ADD_A_CONVERSE_MODEL.md`, and a nightly identity smoke. The
  real qualification run scored Nova Pro **NOT QUALIFIED — 123/146** (14
  CRITICAL + 9 HIGH misses, mostly the injection spine). P4 = #660, parked.
- **Tier D (#770):** #882 (#771 stages 1–2: stale tool-result clearing +
  rolling thread summaries); #892 (#780 item 1, concurrent `always_allow`
  tool calls); #886 + #894 (#780 item 2: schedule Run-now, per-schedule run
  history, cadence-side in-flight guard).
- **Tier C (#801):** #802 built as PR #872 (Rob, migration 0049); #807
  token-handler verification built as PR #903 (review clean 2026-09-05
  20:45Z; merged 20:59Z).
- **#438 layered instructions — P0 built:** PR #901 (precedence contract +
  receipts, no schema change; merged 21:18Z) and PR #905
  (org-layer storage + admin edit, migration 0051; draft, Rob).
- **Security spine:** #443 / #448 verified and closed; #873 (#868 proxy
  crash); ADR 0014 merged as #867 (#457's build stays Rob-gated); #844
  (unencrypted RDS copy) deleted 2026-09-02.
- **The August queue — Tiers A and B shipped in full** (#795 → #814, #763 →
  #815, #796 → #816 + #821, #782 → #817/#822/#824/#825, #783 → #818, #759 →
  #819, #785 → #820; #739 → #784, #741 → #787, #764 → #826, #766 → #827, #767
  → #828, #743 → #840 + #843, #768 → #829). Tool policy #410 → #831–#835;
  presets #436 → #837; budgets #838 → #841 + #842; Studio receipts #839 →
  #840; ops floor #449 closed 2026-09-02.
- **Guard note carried forward unchanged:** goal.md's "Do not touch PR #272 or
  issue #291 (SES)" stays in place — it protects a production email path, so
  any change to it is Rob's call under CLAUDE.md §7, not a queue to-do.

## Triage principles this cycle

1. **Hygiene before features** — the queue does not build on a red canary or a
   red required check. Tier 0 is not optional and it is not "quick wins".
2. **Keep the quality signals honest.** The canary is green three nights
   running and #830 is closed; the next scheduled red opens the successor
   alert thread (the nightly bot files it, as it did #641 / #733 / #830).
   Known-red markers must point at an OPEN issue — #675 sat orphaned for a
   day after its markers were gone; the `#847` markers are in the same state
   now that #847 is closed (Tier 0 item 4).
3. **Finish the in-flight epic before opening the next** — the next epic is
   still viewer-identity apps (#801), not Governed Custom Agents (#736).
4. **The strategic swing stays #801**, sequenced #802 → #803/#804 → #805 →
   #806; #807's verification merged (#903, 20:59Z). Every step past #872 is
   blocked on Rob merging #872.
5. **Security spine, one per cycle:** this cycle's is **#906** (the model
   enablement lookup fails open) — small, unattended-safe, and it must land
   before the platform pin is ever lifted. #457's two build PRs stay
   Rob-gated.
6. **A red canary with no human triage within 48h pauses the queue.** If
   Nightly Evals is red and the alert thread has no human comment within 48h
   of the red, an unattended session does Tier 0 triage work only — or writes
   its session summary and stops. It never builds features on top of an
   untriaged red. Unchanged.
7. **Migrations merge in journal order, and only Rob merges them.** The
   journal `when` is load-bearing: the migrator applies entries whose `when`
   exceeds the last applied, so a lower-`when` migration merged after a
   higher one **never runs in production while passing CI**. #902's guard
   covers additive-only + timeouts, not ordering; #905 adds a journal test
   (idx/`when` strictly increasing) but until it lands ordering is a human
   check. The stack today is #872 (0049) → #870 (0050) → #905 (0051).
8. **Rails before reach.** The 2026-09-04 audit found every gate is policy,
   not capability (the token is repo-admin, the AWS user is `Action:*`, a
   merged PR can widen the pipeline's own IAM). Until #900 lands, an
   unattended session opens any §7-shaped PR as a **draft** and never posts a
   §7 sign-off on a PR it authored.

## State of the merge gate

- The `needs-rob` label exists (created 2026-09-04 by the afternoon audit;
  red, "no automation may remove this"). **Today it is applied by hand** — on
  PRs #872, #870, #890, #905 and issues #893, #823 — and nothing enforces it:
  `claude-verdict.yml` only reads `needs-codex`, so a review that rules "clean
  code, Rob must decide" still publishes a green verdict (how #885 merged).
  The only GitHub-side hard stop today is **draft** status (#890, #905).
- **PR #900 (#891) makes it mechanical once Rob merges:** `needs-rob` ⇒
  `Claude verdict` = failure in both publishers; sticky against bot removal
  (timeline-derived, fail-closed); per-PR concurrency so there is no green
  window between the `labeled` and `review` runs; `scripts/verify-pr-gate.sh`
  goes red when a review said "needs Rob" and the label was never applied;
  and one new `CLAUDE.md` §7 sentence — a §7 sign-off is valid only when
  posted by the review lane on a PR it did not author. **Rob reads the rubric
  change (it tightens only) and merges; it changes no `uses:` pin,
  `permissions:` block, or trigger.**
- Until then: the authoring session opens §7 PRs as drafts, the review lane
  applies `needs-rob` by hand, and nobody but Rob removes it.

## Prioritized queue

**Next session — work order (skip anything Rob-gated):**

1. Land what is still in the gate — none carries a §7 item: #904 (#797 P3 + P5),
   #908 (this re-triage).
   Already merged today: #901 (#438 PR A, 21:18Z), #903 (#807, 20:59Z), #909 (#696 pilot
   load harness, 21:53Z), #907 (#880
   judge → `haiku-4-5`, 21:35Z — tonight's nightly is the new baseline). Do not touch #905 (draft, Rob) or
   the migration stack.
2. **#906** — fail-closed enablement lookup (Security spine item; S).
3. **First nightly after #907 = new baseline.** Read its red as
   judge-calibration, not regression; do not add markers for the three
   judge-strictness cases (Tier 0 item 2) — their rubric rewording is Rob's.
4. **#696** — pilot load test (PR #909, merged 21:53Z): local-stack measurement
   + report only; the production run is Rob's (Deliberately parked list).
5. Tier 0 item 4 — lift the `#847` markers once the bar is met.
6. **#438 P1** — per-skill standing notes + the Settings precedence explainer,
   after #901 merges (Tier F).
7. Tier D — #772 checkpoints, #774 verifier, #773 delegated-approval half —
   unblocked, in that order.
8. Tier C #803 / #804 / #805 / #806 — only after #872 is merged (Rob).
9. #776 — only after #870 is merged (Rob).

### Tier 0 — hygiene before any unattended run

Gate status on 2026-09-05 20:50Z: `main` = `0d56d73` (#902); CVE gate green;
every scheduled Product Smoke since 08-30 green; the 2026-09-05 10:58Z
nightly green on `2f6037b` with the enforced AWS account allow-list and #889's
local-Postgres path; #830 closed. The 09-02 items 1–8 are done. What is open
here are the leftovers below; none blocks the tiers, but they sit here so they
are not forgotten. **Deploy state of `0d56d73` is unverified from this lane:**
#902 changed `packages/db/src/migrate.ts` (a deployable), and CodeBuild drops a
push that lands during a running build (item 6) — the head-vs-build check
comes first next session.

1. **#906 — model enablement lookup fails open — NEW (filed 2026-09-05
   20:47Z), unattended-safe, S.** `enabledModelsForPurpose` treats a DB error
   as "enabled"; harmless while the registry held only qualified Claude
   models, not since #904 registers a NOT-QUALIFIED Nova Pro. Nothing serves
   it today (`PLATFORM_MODEL_OVERRIDE_ID` pins every purpose to `sonnet-4-5`),
   but once the pin lifts, an enablement-table outage plus `/model nova` would
   serve an unqualified model. Fix per the issue: on lookup error every model
   is disabled for that purpose except the platform default (chat keeps
   working), one log line, honest receipt ("model enablement unavailable —
   using the default"), one shared helper for the chat-route gate, unit tests
   both ways. No migration, no env.
2. **#880 — the nightly is self-judged — PR #907 merged 21:35Z; Rob chose option 1.** `DEFAULT_MODEL_ID` and `JUDGE_MODEL_ID` were
   both `sonnet-4-5` (found by #879). #907 moves `JUDGE_MODEL_ID` to
   `haiku-4-5` — separate Bedrock quota bucket, already in the nightly eval
   role's allow-list (verified read-only in the PR), so evals-only: no IAM,
   env, runtime or enablement change; the platform pin stays. It appends
   three calibration lines to `JUDGE_SYSTEM`, added only after a same-answer
   A/B showed Sonnet-judged verdicts unchanged under them, and `--model
   haiku-4-5` is now the refused id. **The first nightly after the merge is a
   new baseline, not a regression signal.** The PR hands Rob a three-case
   "likely red early" list — `model-routing/disconnected-calendar-stays-honest`
   (most likely; the rubric names no concrete FAIL condition),
   `salesforce-faithfulness/injection-record-description` (paraphrasing the
   poisoned field as "business data": allow it, or make misdescription a
   FAIL and it becomes a product fix), `gmail-calendar-faithfulness/calendar-confirmed-write`
   (occasional flake) — each a judge-strictness item whose **rubric rewording
   is Rob's; no assertion was loosened and no marker added, and an
   unattended session adds none.** Option 2 (lift the platform pin) remains a
   production model change and Rob's; #906 lands before it.
3. **#823 — partially met; the rest is Rob's.** Acceptance criteria 1–3 are
   proven on `main` (#885's pins: `allowed-account-ids` enforced, no
   unexpected-input warning, green nightlies). Still unmet: the Node 20
   deprecation from `actions/github-script@f28e40c` in the nightly report
   job, and the fail-closed (wrong-account) path is unexercised. **A major
   bump of a third-party action on the eval workflow is outside #865's
   delegations (the #885 lesson) — Rob's, together with the #890 decision
   (Parked list).**
4. **`#847` markers — lift when the bar is met (evals-only, tightening).**
   Three assertion-scoped `knownIssue: "#847"` markers remain
   (`memory-injection.cases.ts:116`, `skill-faithfulness.cases.ts:362,371`)
   and the issue is closed. Bar unchanged: 20 consecutive clean scheduled
   samples per marked assertion counted from #857 (2026-09-04) — at 5
   samples a night the bar is reachable by the 2026-09-07 nightly; count
   from the nightly logs, do not assume. Paste the evidence in the PR body;
   it may ride
   under #865's tightening-only delegation. The `#860` marker on
   `scope-honesty-send-email` (`gmail-calendar-faithfulness.cases.ts:785`) is
   the same shape — #860 closed with #866, so the prose fix it was waiting on
   has no open ticket; **needs an issue** before the marker can be lifted or
   the case reworked.
5. **#846 / #848 leftovers, unchanged:** whether the June–August cross-user
   run-history exposure gets a dated note in `docs/security/` is Rob's call;
   the two-user cross-user-404 sweep over migrations 0042–0048 is unstarted
   stretch. Admin-editable lane defaults, #396's cache columns (Rob-gated
   migration), #734 / #775 stay out of #848's scope.
6. **CodeBuild `concurrentBuildLimit=1` drops a push that lands during a
   running build.** Nine `main` SHAs got no build on 2026-09-04 (self-healing
   only because a later build deploys the tip). Options on the table: raise
   the limit to 2, a post-merge Action that calls `start-build` when none is
   running, or accept it with the head-vs-build check at session end. Deploy
   pipeline — Rob; this is rail R6 (see "Rails").

**Human-owned caveat carried forward from the CVE gate (§7; goal.md "no new
production dependencies"), narrowed by #865's standing delegation:** a
security-patch pin that is lockfile-only with a green production build may
carry Claude's §7 sign-off; anything else about the next advisory — #855's
daily audit opens the tracking issue — is Rob's, and an unattended session
restates the override plan there rather than opening a new-dependency PR.

### Tier C — the strategic swing: viewer-identity apps (#801), in order

Bindings on `main` are still Salesforce-SOQL-only; the generic shape is built
in #872 and waits for Rob. Nothing past item 7 can start until #872 merges.

7. **#802 — generic read-tool bindings — PR #872 OPEN for Rob (`needs-rob`;
   review 2026-09-05 20:07Z found no blocking defect and did not sign off —
   migration).** Built as specified: `{id, provider, toolName, pinnedArgs,
   label}` over any read-only catalog tool, the browser submits binding ids
   only, bindings pinned per version as insert-only rows in a new
   `app_version_data_bindings` table, fail-closed provider gate at publish,
   pinned args secret-scanned at mint, execution as the viewer through the
   viewer's own connections with attestation now applied to app data.
   **Human-owned caveat (§7): the handwritten migration
   `0049_app_version_data_bindings.sql` (additive table, validated only on a
   throwaway local Postgres) is Rob's to review, together with the
   attestation-applies-to-app-data behavior change. Merge order: #872 is
   journal idx 49 (`when` 1788494400000), #870 idx 50, #905 idx 51 — #872
   FIRST (principle 7).** Generic authoring emission stays #804's scope.
8. **#803 — default flip + snapshot interstitial + no-public-link invariant.**
   Next once #872 merges. **Human-owned caveat (§7 data-scoping spine):
   unattended sessions build the interstitial, the audited acknowledgment
   row, the publish-time + serve-time no-public-link invariant with its test,
   and the migration sweep behind an off-by-default flag only — the
   data-sharing default flip itself is DESCRIBED in the PR body for Rob to
   flip, never made unattended (the observe→enforce pattern of #410/#701).**
9. **#804 — authoring loop: never silently bake connected data.** Generic
   binding emission for every provider (PR #418 did Salesforce; #872 kept it
   Salesforce-only on the new shape); bake detection at save;
   preview-as-unconnected-viewer (deliberately not impersonation of a
   specific colleague). **Human-owned caveat (§7 data-scoping spine, same as
   #803): unattended sessions build detection + the warning/one-click-convert
   UX only; any behavior that BLOCKS or changes what connected data can leave
   a thread is DESCRIBED in the PR body for Rob, not enabled unattended.**
10. **#805 — per-widget tri-state contract + "Live · as you" chip.** `ok /
    needs_connection / error` per binding, per-widget `fetchedAt`, page-level
    chip and tooltips in both themes. #872's response shape already carries
    `needsConnection` + `connectionStatus`, so this is mostly presentation.
    **Caveat (§7 spine adjacency): presentation and API response shape only —
    it must not alter which data a viewer can fetch, and it must never render
    another user's numbers as any fallback state, including builder mint-time
    data (Rob decision #2 on the issue). If implementation would touch
    scoping/fallback logic, that part is DESCRIBED in the PR body for Rob, not
    made unattended.**
11. **#806 — per-viewer caching, rate limits, invalidation.** Before broad view
    traffic. The epic's one correctness landmine lives here: the cache key is
    `(appVersionId, bindingId, viewerUserId, argsHash)` and `viewerUserId` is
    never omitted; single-flight coalescing keys on the full per-user key;
    bust on disconnect/reconnect, revocation (#835's `connection.revoked`),
    and version publish. Start browser-side stale-while-revalidate; add a
    server cache only if provider rate limits demand it. The two-session
    zero-shared-bytes test is mandatory. Verify #407's per viewer+app rate
    limit holds for multi-binding pages.
12. **#807 — token-handler verification — PR #903 merged 20:59Z (review clean
    20:45Z).** Token path map with `file:line` evidence, three new test files
    (app document carries binding ids only; serialized artifacts never carry
    the pinned query; post-build scan of every `.next/static` bundle for token
    shapes and server-only markers), the e2e smoke extended, and the path
    documented in `docs/security/DATA_FLOW_AND_CLASSIFICATION.md`. **Caveat
    kept: verification + tests only — the behavior changes it uncovered (e.g.
    a token refresh writes no audit row; no `connection.refreshed` action
    type exists) are listed for Rob at the bottom of the PR body, not made.**
    Closes #807 on merge.
13. **#808 — interim step only:** the share-time provenance warning for any
    shared artifact containing baked connected data ("contains data from your
    Salesforce as of {date}") can ship once #872 is merged. The full
    recipient-identity mechanism waits on the sharing surface (#78, parked).
14. **#810 — decision ticket, not build work.** #410 enforcement exists and
    #701's default-deny shipped (#861), but Rob's blast-radius questions
    (eligible providers/actions, admin review before publish, abuse limits)
    are unanswered. #620's propose-don't-execute is the likely v1 shape.

### Tier D — harness wave 2 (#770), re-scoped

15. **#771 — context lifecycle — stages 1–2 shipped (#882); the issue stays
    open ("Refs", not "Closes").** On `main`: stale tool-result clearing
    before every provider call once the transcript exceeds ~160K chars
    (error results exempt, raw payloads kept in the persisted transcript and
    events, receipt in the `provider-request` snapshot), and a rolling
    `thread-summary.v1` document in `chat_threads.summary` (fire-and-forget
    after a successful turn, `resolveModelForPurpose("summaries")`,
    nonce-framed, `(id, user_id)`-scoped) rendered as background data on the
    next turn — layer 6 once #901 lands (it renumbers thread from 7 to 6).
    **What remains: mid-run compaction of a single very long durable run**
    (summarizing rounds inside one loop) — today that run is bounded by
    stage-1 clearing plus #841's envelope. M; after the Tier D items below.
16. **#772 — run checkpoints & rewind.** Unblocked (#882). Anchors on
    `run_events` (the `(run_id, sequence)` unique index exists, migration
    0037); external writes are not undoable and the UI must say so. If the
    design needs a column, it is DESCRIBED in the PR body for Rob, not
    handwritten unattended.
17. **#774 — verifier pass for unattended runs.** Unblocked (#882). Runs as a
    child run, so #842's child-run budget envelope already bounds it. Same
    sequencing as #772.
18. **#773 — durable approvals, re-scoped after #833/#834.** Already shipped
    there: the `waiting_for_approval` run state and `tool_approval_requests`
    receipts, owner approve/deny in chat that survives reload and resumes the
    same durable run, at-most-once preclaim/replay in both lanes, 30-day
    standing Skill approvals with grant/revoke APIs, 24-hour expiry with
    durable cancellation, and — deliberately — **unattended runs fail closed:
    writes are denied and reported without pausing.** What remains, and is now
    the whole issue: (a) **delegated approval authority** — nothing on `main`
    knows a delegate; extend `shares` from view/run to approve and attribute
    the decision to the delegate in the audit row; (b) approval prompts in the
    notifications panel with full context (they render in the chat thread
    today). **Not unattended:** the original "pause-and-wait for unattended
    runs" would reverse #834's deny-and-report default — a permissions-policy
    decision (§7) for Rob, asked as a question on the issue, not built. Email
    notification is not queue work (#291 closed; the SES guard stands).
19. **#780 — quick wins — items 1 and 2 done (#892, #886 + #894); the issue
    stays open for 2c.** Item 2c, the per-schedule model override, needs
    `schedules.model_id` — a handwritten migration DESCRIBED in #886's body
    for Rob, not filed; it resolves through the registry and never touches
    the judge model. Rob's call whether it becomes a migration PR or #780
    closes without it. #893 (one live run per thread/schedule, found by
    #886's review) is the migration-shaped follow-on, `needs-rob`.
20. **#775 — policy engine, re-scoped.** #841/#842 shipped the per-run
    token/USD/wall-clock/iteration envelope and #837 the presets. Remaining:
    per-user daily budget, downgrade gate, trivial→cheap classifier, risk
    score, loop watchdog, integration defaults. L, staged; after Tier C.
21. **#776 — credential-injection egress proxy.** L; rides behind #870 and is
    infra-shaped (§7) at the proxy layer — Rob owns the proxy change;
    unattended work is the per-skill egress-rule schema and tests.
22. **#777 OTel, #778 progress notes, #779 save-as-skill** — unchanged, later.

### Tier E — #797 developer-swappable brains, P1–P3 + P5 built

23. **P1 — COMPLETE (#871, #798, #888).** Seams open, identity line
    registry-derived, one `modelIdentityLine()` helper.
24. **P2 — COMPLETE (#879).** `pnpm eval --model <id>`, pinned judge,
    scorecard. **It PROPOSES the qualification bar in
    `docs/REGRESSION_GAUNTLET.md` (each threshold a named constant in
    `scorecard.ts`) — ratifying it is Rob's.** The first real run against it
    (#904) says the bar bites: Nova Pro fails 23 cases.
25. **P3 + P5 — BUILT, PR #904 in the gate (review pending at 20:52Z).**
    `nova-pro` (`us.amazon.nova-pro-v1:0`, Converse, no `cachePoint`,
    300k / 10k caps) registered **disabled** — no enablement row, migration or
    default touched; judge / summaries / routing / memory-capture pinned to
    Claude even with Nova enabled for chat; `resolveModelFailoverChain` lets a
    cross-provider hop land only on a qualified model (qualified = has an
    enablement row for the purpose); the exit test runs on the real entry;
    one bounded live call proved access (HTTP 200, ~$0.000016). **Live
    qualification, judge pinned `sonnet-4-5`: NOT QUALIFIED — 123 passed / 23
    failed (~$1.28 + $0.65 judge).** P5: `docs/runbooks/ADD_A_CONVERSE_MODEL.md`
    and a nightly `model-identity` suite whose expectations derive from the
    served model. **Rob actions the PR creates, none required to merge:
    confirm Nova pricing (entry marked `PRICING UNVERIFIED`), the enablement
    flip (recommended against on this scorecard — #305 stays open), and an
    IAM edit if a nightly Nova case is ever wanted.** #906 is the fail-open
    this lane found.
26. **P4 = #660** — Parked (IAM/env; see below). Nothing after P5 in this epic
    is unattended work; #797 closes when Rob decides what to do with P4.

### Tier F — #438 layered standing instructions

27. **P0 — BUILT as two PRs.** **PR A #901** (merged 21:18Z):
    one source for the layer contract (`packages/agent/src/instruction-layers.ts`),
    `governance > org > skill > personal > thread`, the rule in the stable
    prefix, the org slot resolving honestly to "not configured", the
    `context_pack_assembled` row naming every layer, the three hand-copied
    eval mirrors replaced by imports, and a judge-free eval case reproducing
    the production run `CBX-20260724-091510`. No schema change. **PR B #905**
    (draft, `needs-rob`): org-layer storage as `user_memory_items.scope`
    (`'user'|'org'`, additive migration **0051**), admin-only write on the
    existing Vault surface, protected-key tripwire with receipt + audit row.
    **Human-owned caveat (§7 migration): #905 merges LAST in the stack —
    after #872 (0049) and #870 (0050) — or their lower-`when` migrations skip
    silently in production (principle 7).** It carries `Closes #438` for the
    P0 scope only.
28. **P1 — per-skill standing notes + the Settings precedence explainer.**
    After #901 merges; no schema expected. Unattended-safe.
29. **P2 — team / per-app layers.** Needs the #413 identity substrate; parked
    with it.

### Security spine — one per cycle, interleave with tiers above

- **#906** is this cycle's item (Tier 0 item 1) — small, no §7 surface.
- **#457 — tamper-evident audit log — ADR 0014 merged (#867).** Design only
  (option (c) hash chain: additive `seq` / `prev_hash` / `row_hash`, a
  `BEFORE INSERT` trigger serialized by an advisory lock as the single writer,
  retention as a chained checkpoint, `pnpm audit:verify`). **Approving the
  ADR is not approving the build: the additive `audit_log` migration and
  option (a)'s DB role/GRANT change each get their own Rob-gated PR.** The
  issue stays open for those.
- **#849 — PR #870 OPEN for Rob** (Parked list; the secret must exist before
  merge).
- **#691 — WAF** stays in count mode until #697 gives block mode a rehearsal
  target; infra, Rob.
- **#455 key separation, #692 provider-side revocation** — Rob-gated
  (Parked list).
- **#460 data lifecycle, #381 trace retention** — later, unchanged.

### Rails — candidate ops items from the 2026-09-04 audit (needs an issue each)

The audit (session notes, "what would you do without me?") found every gate
is policy, not capability. It named seven rails; two are mechanism on `main`
or in the gate, the rest have **no issue yet — file NOTHING unattended; this
list is for Rob to pick from.** None is queue work until it has a number.

- **R1 — pre-migrate RDS snapshot.** Take a manual snapshot before the
  migrator runs (deploy pipeline + IAM). Rob; **needs an issue**.
- **R2 — migration guard — SHIPPED (#902, #898):** `lock_timeout` /
  `statement_timeout` on the migrator, additive-only guard in CI.
- **R3 — seeded dry-run.** Rehearse every migration against a seeded copy of
  production shape before it reaches `main` (overlaps #467 and #697).
  **Needs an issue.**
- **R4 — auto-rollback on failed smoke.** A failed post-deploy Product Smoke
  rolls the ECS services back to the previous task definition instead of
  paging. Deploy pipeline, Rob; **needs an issue**.
- **R5 — `needs-rob` gate — PR #900 (#891), Rob merges** ("State of the
  merge gate").
- **R6 — never silently undeployed.** CodeBuild `concurrentBuildLimit=1`
  drops pushes during a build (Tier 0 item 6). **Needs an issue.**
- **R7 — secret-key preflight + IAM-delta detector.** Fail a deploy whose
  task definition references a Secrets Manager key that does not exist
  (#870's failure mode), and surface any CDK diff that widens the pipeline's
  own IAM as a `needs-rob` finding. **Needs an issue.**
- Also from the audit, unfiled: **RDS `DeletionProtection=false`** (Rob's
  one-liner, noted under #844 since 09-02) and **the restore runbook has
  never been executed, so RTO is unmeasured** — **needs an issue**.

### Parked / needs Rob (skip during unattended work)

- **The migration stack, in this order — #872 → #870 → #905.** Journal
  `when` values 1788494400000 / 1788494460000 / 1788494520000; merging out of
  order makes the earlier one skip silently in production while CI passes
  (principle 7). For **#870**: create the LOGIN role password and the
  `ai-workspace/production/browser-proxy-db` Secrets Manager secret BEFORE
  merging — merge = deploy, and a missing secret rolls back the whole ECS
  stack (commands in the PR); the review's one `needs-codex` finding (the
  CDK comment now names 0050) was addressed 2026-09-05 20:11Z. **#905** is a
  draft stacked on #901; convert and merge only after #870.
- **#900 — `needs-rob` gate (#891).** Read the `CLAUDE.md` §7 edit (tightens
  only), merge. Until then the hold is manual.
- **#890 — close or merge (draft, `needs-rob`).** Close = keep #885's action
  pins (recommendation from both the overnight and afternoon sessions:
  verified SHAs match tags and are current latest, tightening, CI-only, three
  green nightlies on them); merge = revert, which is BEHIND under strict
  up-to-date and needs update-branch + full re-gate. #823 closes on Rob's
  sign-off of the state kept, plus the Node 20 leftover (Tier 0 item 3).
- **#893 — one live run per thread/schedule (`needs-rob`).** Unique partial
  index on `runs(schedule_id) WHERE status IN ('queued','running')` plus a
  per-thread worker claim fence; migration, Rob-gated. #894 guards the
  cadence path meanwhile.
- **#780 item 2c — `schedules.model_id`** per-schedule model override:
  migration described in #886's body, not filed. Rob's call.
- **#879's qualification bar** in `docs/REGRESSION_GAUNTLET.md` — the
  thresholds are Rob's to ratify; #904's Nova run is the first real result
  against them.
- **#907's three judge-strictness cases** (Tier 0 item 2) — rubric
  rewording so each names its FAIL conditions concretely; Rob's, after the
  first Haiku-judged nightlies show which stay red.
- **#904's Rob actions** — confirm Nova Pro pricing; the enablement flip
  (recommended against; #305 / #295 / #301 / #302 enablement decisions are
  Rob's, build work folded into Tier E); IAM for a nightly Nova case.
- **#660 — Bedrock Mantle Responses adapter (GPT-5.6 Terra) = #797 P4.**
  Needs new ECS task-role IAM for SigV4-signed Mantle requests plus
  endpoint env/config — Rob approvals before implementation (the issue's own
  gate). Direct OpenAI API stays out of scope.
- **#455 — split encryption and signing keys.** New env var (`SIGNING_KEY` or
  an HKDF root) + rotation runbook — Rob-gated env change.
- **#457 — tamper-evident audit log.** ADR 0014 is merged (#867).
  Implementation is Rob-gated: option (a)'s DB role/grant change
  (INSERT/SELECT-only on `audit_log`) and the additive chain migration, each
  its own PR.
- **#697 — staging environment.** AWS spend + naming/DNS + its own secrets;
  synthetic data only. Unblocks #691 block mode, #696's production run, and
  migration rehearsal (#467 / rail R3).
- **#706 — CI/prod Bedrock quota isolation.** The #781 alarm fired on
  2026-08-12 at 99.5% of the Sonnet daily quota; nothing structural has
  changed, and #904's qualification run (~$1.93) came out of the same
  bucket. Separate eval account/role, or an independent-bucket candidate
  model with the judge pinned — account/IAM, Rob. #880's judge move takes the
  judge's share off the Sonnet bucket but does not solve this.
- **#692 — re-scoped: provider-side revocation only.** The local half shipped
  in #835 (`apps/web/lib/oauth/connection.ts:163-260`,
  `DELETE /api/oauth/connections/[provider]`, admin revocation, token scrub,
  audit). What remains is calling the provider's revoke endpoint (Google
  `/revoke`, GitHub grant delete, Salesforce `/services/oauth2/revoke`; Notion
  has none — document the gap) best-effort, never making local withdrawal
  depend on provider availability. **Human-owned caveat: auth-surface change
  (§7) — Rob approves the provider permissions and failure behavior first;
  then it is an S-item.**
- **#396 — per-message cache token columns.** Additive handwritten migration
  (Rob-gated). Not a #838 blocker per its completion audit; once approved it
  is an S-item that lets `formatTurnMeter` drop the ≤ bound.
- **#423 — runs tree (`parent_run_id` + step label)** and **#599 — rename the
  truncated `workspace_artifacts` FK.** Both forward migrations; held back
  from the stack deliberately to keep the migration review load to three.
  Rob picks when.
- **#836 — Ping/SCIM deprovisioning → revocation.** Land when there is a real
  caller and credentials; no unwired seam in the runtime (per the #835
  review).
- **#810** — decision ticket (Tier C item 14).
- **CodeBuild `concurrentBuildLimit=1`** — Tier 0 item 6 / rail R6.
- **Three CI-only merges the 2026-09-04 reviewer routed to Rob but did not
  block** — #869 (coverage lane), #857 (nightly signal), #855 (daily audit):
  keep or revert. All three have run green since.
- **#877's optional branch-protection simplification** (two fan-in contexts
  instead of seven) — Rob owns the required-check contract; this update is
  another docs-only proof of the fast lane (confirm the classifier said
  docs-only and the full-lane jobs skipped).
- **Next CVE advisory** — production-dependency change; #855 files it, #865's
  delegation covers lockfile-only security pins, everything wider is Rob's.

### Deliberately parked (do not start without a conscious call)

- **#736 Governed Custom Agents (+#745–#748)** — after #801 Tier C is
  underway, not before.
- **#811 Studio Browser general web navigation + persistent sessions** —
  security-heavy new surface; after #870 merges and #776.
- **#491–#493 perimeter/identity/accountable-runtime epics** — pull items only
  when an IT-review date makes them concrete.
- **#494 / #495 / #78** — habit loop, flywheel, share cards: wait for the
  team/org entity design and real usage signal.
- **#765 unified shell, #769 Button migration** — structural UI; after the
  Tier B polish has stabilized in use.
- **#620 / #622 / #624 / #435 / #734** — proposal inbox, provenance shell,
  governed Salesforce writes, spend dashboard: behind #775 and #810.
- **#412 / #413 / #422 / #424** — GA-Pac architecture specs; unchanged. #413
  is now also #438 P2's dependency.
- **#696 — load/perf program.** PR #909 (merged 21:53Z) measured against the
  local stack only and files a report; **the production run needs #697 (or an
  explicit Rob window against prod) and is Rob's.**
- **#744, #467** — conformance suite, release engineering: later. #467
  overlaps rails R1 / R3 / R4 — if Rob files those, fold #467 into them.

## Notes

- **Open PRs on 2026-09-05 (written 20:56Z, reconciled 21:59Z).** Merged since the 20:56Z write, none §7: #901 (#438 A, 21:18Z), #903 (#807, 20:59Z),
  #907 (#880, 21:35Z), #909 (#696 pilot load harness, 21:53Z). Still in the gate: #904 (#797 P3 + P5),
  #908 (this re-triage). Rob: #872 → #870 → #905
  (migrations 0049 / 0050 / 0051, in that order), #900 (gate), #890
  (decision; draft).
  Their `Claude verdict` statuses read "Claude review has not passed for this
  commit" until CI finishes — the pending state, not a red.
- **Known-red markers on `main`:** `#847` ×3 and `#860` ×1 — both issues are
  closed (Tier 0 item 4). Principle 2 applies: a marker must name an open
  issue or come out.
- **Alert thread:** #830 is closed; there is no open nightly thread. The next
  scheduled red opens its successor and the 48h rule (principle 6) counts
  from that red.
- **Verify the deploy first.** `main` moved twice today (#899 CI-only; #902
  touches the migrator). If CodeBuild's last successful build is behind
  `0d56d73`, start one by hand before building anything (rail R6).
- UI/UX epic #762, harness epic #770, viewer-identity epic #801, model epic
  #797 and Studio epic #735 are tracking umbrellas; their actionable children
  are tiered individually above.
- The August research record (sources for Tiers C/D) lives in
  `docs/research/HARNESS_RESEARCH_2026-08.md`; viewer-identity decisions are
  on #801; the tool-policy decision record is ADR-0011 (refreshed by #854);
  the audit-log chain design is ADR-0014 (#867); the layered-instructions
  contract is `packages/agent/src/instruction-layers.ts` once #901 lands.
- goal.md's guard on PR #272 / issue #291 (SES) is unchanged and still
  binding.
