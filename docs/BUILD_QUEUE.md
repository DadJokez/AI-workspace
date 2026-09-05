# Build Queue — re-triaged 2026-09-02, updated 2026-09-04 (part 2, 12:40Z)

Prioritized, dependency-ordered queue of open work. Re-triaged three weeks
after the 2026-08-12 queue: its Tiers A and B shipped in full, the #410
tool-policy series (#831–#835), autonomy presets (#837), and per-run budgets
(#841–#843) landed on `main` on 2026-08-15/16 — and then nothing merged for
17 days while the nightly canary went red on 10 of 18 nights. The 2026-09-03/04
overnight session cleared that gap: 32 PRs merged by 12:34Z, Tier 0 is done
except for one Rob-gated item, #797 P1 + P2 are complete, and `main` is at
`e6286a3` (PR #894). Part 1 of this update (#884) was the #812 docs-only fast
lane's first proof (#877); this is its second.

**Consumed by `/goal`** (`.claude/commands/goal.md`): an overnight session works
this queue top-down, skipping anything whose dependencies aren't merged to
`main` or that is human-gated. Re-triage when this file is more than ~2 weeks
old or the queue is empty (goal.md Phase 2.1) — next check-in 2026-09-18.

## Completed since the 2026-08-12 triage

- **2026-09-03/04 overnight — Tier 0 cleared** (outcomes inline under Tier 0
  below): #845 CVE gate → #852 + #863; #847 anti-echo flakes → #857 (rejoin
  bar still open); #701 write boundary → #861; #846 scoping guard → #858;
  #848 budget truncation → #859; #850 ADR-0011 → #854 (+ #861); PR #798
  identity seam merged 2026-09-04. Only #849 (PR #870) remains, Rob-gated.
- **CI reliability, same night (the Tier 0 addendum):** job caps #864 / #878 /
  #881, bounded advisory-registry attempts #876 (#875), scheduled daily
  production dependency audit #855 (#853), smoke settle #874 (#813), and the
  #812 docs-only fast lane #877. Rob's standing §7 delegations (security-patch
  pins, tightening-only enforcement) were recorded in `CLAUDE.md` by #865.
- **Second wave, 2026-09-04 10:00–12:35Z (after part 1 of this update):**
  #882 (#771 stages 1–2: stale tool-result clearing + rolling thread
  summaries), #886 + #894 (#780 item 2: schedule Run-now, run history, and
  the cadence-side in-flight guard), #888 (#856), #879 (#797 P2), #883 →
  #889 (#708 and #887: CI Postgres from the runner image, no registry
  pulls), #867 (ADR 0014), and #885 (#823 action pins — merged, then ruled
  §7 by the review; its revert #890 is held for Rob).
- **Tier E P1 and P2 complete:** #871 opened the seams (`supportsPromptCaching`
  / `invocation` on `ModelMetadata`, conditional `cachePoint`, open runtime
  union, registry-derived alias table), #798 derived the identity line, and
  #888 closed the P1 leftover #856 (one `modelIdentityLine()` helper). P2's
  qualification harness shipped as #879 (`pnpm eval --model`, pinned judge,
  scorecard); the bar it proposes in `docs/REGRESSION_GAUNTLET.md` awaits
  Rob's ratification.
- **Security spine:** #443 / #448 verified against `main` and closed; #695
  coverage → #869; #868 proxy crash → #873. #457's hash-chain design is
  ADR 0014, merged as #867 (the build stays Rob-gated). Earlier: #410 closed
  by the five-PR series #831
  (persisted tri-state policy, migration 0045) → #832 (runtime refusal of
  `blocked`) → #833 (durable interactive approvals, 0046) → #834 (standing
  Skill approvals + unattended deny-and-report, 0047) → #835 (connector
  lifecycle governance + `/admin/connectors`, 0048). #436 presets → #837.
  ADR-0011 caught up in #854.
- **Tiers A and B of the August queue — shipped in full** (PR map under
  "Prioritized queue" below). Nothing from either carries forward.
- **Accountable runtime:** #838 per-run budget envelope → #841 + #842; #839
  Studio guardrail receipts → #840. Studio Browser #756 → #799/#800/#809;
  #758 → #760.
- **Ops floor #449** closed 2026-09-02: its closing condition (#579/#568) was
  met in July; SHA-pinned deploys and the 11 ops alarms verified OK.
- **Guard note carried forward unchanged:** goal.md's "Do not touch PR #272 or
  issue #291 (SES)" stays in place — it protects a production email path, so
  any change to it is Rob's call under CLAUDE.md §7, not a queue to-do.

## Triage principles this cycle

1. **Hygiene before features** — the queue does not build on a red canary or a
   red required check. Tier 0 is not optional and it is not "quick wins".
2. **Restore the quality signals** — a permanently red canary is worse than
   none (unchanged from August; August's fix did not hold).
3. **Finish the in-flight epic before opening the next** — Contribution Studio
   (#735) tracks are closed; the next epic is viewer-identity apps (#801), not
   Governed Custom Agents (#736).
4. **The strategic swing stays #801**, sequenced #802 → #803/#804 → #805 →
   #806 → #807, with every human-gated step stated inline on the item.
5. Security spine items ride one-per-cycle as always; #701 was this cycle's
   and shipped (#861). #457's ADR 0014 merged (#867); its two build PRs are
   Rob-gated.
6. **A red canary with no human triage within 48h pauses the queue.** If
   Nightly Evals is red and the alert thread (#830 or its successor) has no
   human comment within 48h of the red, an unattended session does Tier 0
   triage work only — or writes its session summary and stops. It never builds
   features on top of an untriaged red. **Status 2026-09-04:** the fix ticket
   #847 shipped as #857 (markers scoped, bot names the failing case); #830
   stays open as the alert thread until the rejoin bar is met. The first
   scheduled red after #857 came at 11:48Z and was triaged the same hour:
   #895, a truncated judge response scored as FAIL, not a product regression.
   The 48h rule applies unchanged to the next red.

## Prioritized queue

**Next session — work order (tier logic unchanged; skip anything Rob-gated):**

1. Land #892 (#780 item 1, in gate) and the #895 judge-truncation PR
   (verdict-first parse, bounded re-sample; no PR open at 12:40Z).
2. Restate the Rob decisions (Tier 0 "still open" list; "Parked / needs Rob")
   on their issues — do not build past them.
3. Tier E P3 — first non-Claude Converse brain (Nova), disabled by default —
   then the P5 runbook.
4. #438 layered instructions — unblocked by #856 (#888).
5. Tier C #803 / #804 — only after #872 is reviewed and merged (Rob).
6. #776 egress proxy — only after #849 / #870 is merged (Rob).

### Tier 0 — hygiene before any unattended run

Gate status on 2026-09-04 12:40Z: `main` = `e6286a3`; the CVE gate is green
(#852, #863); every scheduled Product Smoke since 08-30 is green; the first
scheduled nightly after #857 (11:48Z) went red on one sample — #895, a judge
truncation, not a product regression (the case's honeypot assertion passed).
Items 1–8 are done except item 6 (#849, Rob-gated). The open Tier 0 items are
the Rob decisions at the end of this section (#862, #880, #890/#823, #891,
CodeBuild concurrency); none blocks the tiers below, but they sit here so they
are not forgotten.

1. **#845 — CVE audit was red on every PR — done (#852, #863).** Rob
   authorized the override plan; #852 overrode `fast-uri`, `fastify`, `qs`,
   `@xmldom/xmldom` (2026-09-03) and #863 `browserslist` +
   `postcss-selector-parser` when the gate went red a second time (2026-09-04).
   **Human-owned caveat stands (§7; goal.md "no new production
   dependencies"), narrowed by #865's standing delegation: a security-patch
   pin that is lockfile-only with a green production build may carry Claude's
   §7 sign-off; anything else about the next advisory — #855's daily audit now
   opens the tracking issue — is Rob's, and an unattended session restates the
   override plan there rather than opening a new-dependency PR.**
2. **#847 — dispose of the two anti-echo flakes — done (#857); rejoin bar
   open.** Assertion-scoped `knownIssue: "#847"` on exactly three
   deterministic assertions (judge assertions stay blocking), the two stale
   `#675` markers removed, job timeouts bumped (35→50; canary 20→30 plus a
   10-min step cap on the Chromium install), and the #830 bot names the
   failing case. Rejoin bar unchanged: 20 consecutive clean scheduled samples
   per marked assertion, counted from #857; Rob closes #830 and #847's markers
   together. Related stopgap: #866 marks `scope-honesty-send-email`'s prose
   assertion known-red for #860 (opens with "I'll send that email" before
   self-correcting; judge fails ~2/5) — a prompt-shape fix, not a flake.
3. **#701 — the write boundary fails closed at every registry path — done
   (#861).** `Tool.policy` is required, the loop defaults an undeclared
   policy to `needs_approval`, builtins declare `always_allow` explicitly,
   eval fixtures mirror the catalog rule, and `scope-honesty-send-email`
   passes with both `#701` markers removed. Merged under #865's
   tightening-only delegation with the read/write classification table on the
   PR body.
4. **#846 — per-user scoping regression guard — done (#858).** Scoping
   integration test for the #827 predicate (two users), the `readdirSync`
   grep guard over `apps/web/app/**` with its allowlist, shared `collectText`.
   Still Rob's call, not Codex's: whether the June–August cross-user
   run-history exposure gets a dated note in `docs/security/`. Stretch, not
   started: the two-user cross-user-404 sweep over migrations 0042–0048.
5. **#848 — budget truncation as a first-class signal — done (#859).**
   `run_status` enum kept; `outputs.budgetReceipt` is the field every consumer
   reads via one helper, and accurate receipts land on every terminal path in
   both lanes. Still out of scope: admin-editable lane defaults, #396's cache
   columns (Rob-gated migration), #734/#775.
6. **#849 — the browser egress proxy must not hold the full application
   `DATABASE_URL` — PR #870 OPEN for Rob.** Option A from the issue, zero
   application-code change: handwritten migration
   `packages/db/drizzle/0050_web_egress_policy_reader.sql` (NOLOGIN role,
   SELECT on three `tools_catalog` columns only) plus CDK wiring of a new
   secret `ai-workspace/production/browser-proxy-db` under the same
   `DATABASE_URL` key. **Human-owned caveat (§7 secrets/IAM), unchanged and
   now concrete: Rob creates the LOGIN role and the secret BEFORE merging —
   merge = deploy, and a missing secret rolls back the whole ECS stack. Merge
   order also matters: #870's journal entry is idx 50 and #872's (Tier C
   item 9) is idx 49 — merge #872 before #870, or bump #870's `when` before
   it lands.** Whether the denylist governs the whole proxied session stays an
   open question on the issue.
7. **#850 — bring ADR-0011 up to date — done (#854; #861 recorded the
   default-deny).** Enforcement, the observe-mode fallback for `would_*`
   values (#832), the uncataloged default (item 3), and #436 are all in the
   ADR now.
8. **PR #798 — finish #797 P1's identity seam — merged 2026-09-04.** The
   identity line is derived from registry metadata; the leftover
   single-helper refactor #856 closed with #888 (11:24Z). P1 is complete.

**Tier 0 addendum — landed 2026-09-04 (CI reliability, not on the 09-02
list):**

- **#864 / #878 / #881 — job caps.** `dependency CVE audit` 5 → 12 min (room
  for its retry envelope), `lint + typecheck + build` 10 → 15 min (the
  coverage Test step from #869), scheduled dependency audit 10 → 15 min.
- **#876 (#875) — bounded advisory-registry attempts.** Each registry call in
  `scripts/audit-prod-deps.sh` is time-boxed so a hang resolves to the outage
  path instead of the job cap.
- **#855 (#853) — daily production dependency audit, live.** Scheduled run on
  `main` with a tracking issue, so a new advisory surfaces the same day rather
  than on the next PR. It hands the override plan to Rob (item 1's caveat).
- **#874 (#813) — smoke settle.** The admin-feedback e2e waits for history
  navigation to settle before asserting; the 10s flake is gone.
- **#877 (#812) — docs-only fast lane.** A classifier job decides docs-only;
  the `[full lane]` jobs skip and the summary jobs satisfy the required
  checks. **Rob owns the branch-protection contract; #884 was the first
  proof and this update is the second — confirm the classifier says docs-only
  and the full-lane jobs skipped.**
- **#883 → #889 (#708, #887) — no registry pulls for CI Postgres.** #883
  moved the service container from Docker Hub to the ECR Public mirror; the
  mirror rate-limited the same day (#887), so #889 starts the runner image's
  preinstalled PostgreSQL 16 through a composite action
  (`.github/actions/local-postgres`) instead — four jobs rewired, connection
  strings unchanged.
- **#885 (#823) — `configure-aws-credentials` v6.2.4 + `upload-artifact`
  v7.0.1 pins — merged 11:06Z, ruled §7 by the review 37 s later.** A major
  bump on the OIDC eval-role path is human-owned and outside #865's
  delegations; revert #890 is OPEN and HELD, #823 re-opened. The 11:48Z
  nightly ran both pins green with `allowed-account-ids` enforced. **Rob
  decides: close #890 (keep the pins) or merge #890 (revert), then signs off
  #823 on the state kept.** The gate gap itself is #891.

**Tier 0 — still open (Rob decisions):**

- **#862 — cancel-in-progress on PR refs makes merge-train timing a false
  red.** Two cases on 2026-09-03 (#857 build cancelled mid-`Build`, #858 CVE
  audit cancelled during setup; same-SHA reruns green). **PR #899 builds the
  issue's recommended option 2** under the 2026-09-05 delegation: `ci.yml`
  and `product-smoke.yml` key their `concurrency` group by head SHA; the diff
  is the `concurrency:` blocks only, no `permissions:` change (#699's rules).
  Rob's sign-off is the merge; the proof runs are in the PR body. Either
  way, treat a `cancelled` required job
  as a rerun, not a red (`gh run view --json jobs` shows the conclusion;
  `gh pr checks` does not).
- **#880 — the nightly is self-judged.** `DEFAULT_MODEL_ID` and
  `JUDGE_MODEL_ID` are both `sonnet-4-5`, so judge assertions grade the
  candidate with itself (found by PR #879, which warns loudly but does not
  refuse). **Rob decision: move the judge (e.g. `haiku-4-5`, separate quota
  bucket — smaller blast radius) or lift `PLATFORM_MODEL_OVERRIDE_ID` (a
  production model change; a deliberate window plus one on-demand full-pack
  run).** Either way the first run after is a new baseline, not a regression.
- **#891 — the verdict has no "clean code, human must approve" state.**
  #885 merged on a green `Claude verdict` because only `needs-codex` keeps
  it red. Proposed: a `needs-rob` label treated like `needs-codex` in
  `claude-verdict.yml`, applied by the reviewer for §7 items, removed only by
  Rob. **Workflow edit under #699's rules plus a CLAUDE.md §7 line — Rob
  picks the shape.**
- **CodeBuild `concurrentBuildLimit=1` drops a push that lands during a
  running build.** Three merges tonight needed a manual build start to
  deploy. Raise the limit or queue builds — infra (§7), Rob.

**#844 — done 2026-09-02** (Rob authorized; Claude executed): `ai-workspace-db-unenc-old`
and its unencrypted snapshots deleted; the encrypted snapshot
`ai-workspace-db-enc-20260726` is retained. `--deletion-protection` on the
prod instance remains Rob's optional one-liner.

### Tiers A and B — shipped

- **Tier A:** #795 → PR #814, #763 → #815, #796 → #816 + #821, #782 →
  #817/#822/#824/#825 (closed 2026-08-14 on three green nights, with #733),
  #783 → #818, #759 → #819, #785 → #820.
- **Tier B:** #739 → #784, #741 → #787 (follow-ups #788–#794 closed with it),
  #764 → #826, #766 → #827, #767 → #828, #743 → #840 + #843 (via #839),
  #768 → #829.

### Tier C — the strategic swing: viewer-identity apps (#801), in order

Re-verified 2026-09-02 against the issues and `main`: bindings are still
Salesforce-SOQL-only (`apps/web/lib/app-data-bindings.ts:22`); live-via-viewer
is derived but not the committed default
(`apps/web/lib/app-publication.ts:126-138`); #410's tri-state policy now
enforces rather than observes, so #802's execution path binds to real policy.
Update 2026-09-04: #802 is built and waiting on Rob (item 9).

9. **#802 — generic read-tool bindings — PR #872 OPEN for Rob.** Built as
   specified: `{id, provider, toolName, pinnedArgs, label}` over any read-only
   catalog tool (the #407 SOQL shape still normalizes), the browser submits
   binding ids only, bindings pinned per version as insert-only rows in a new
   `app_version_data_bindings` table, fail-closed provider gate at publish
   (`salesforce`/`github`/`google`/`notion` only; typed 422 + audit),
   pinned args secret-scanned at mint, execution as the viewer through the
   viewer's own connections with attestation now applied to app data (a
   connected-but-unattested viewer gets `needsConnection`, not rows). **Human-
   owned caveat (§7), now concrete: the handwritten migration
   `0049_app_version_data_bindings.sql` (additive table, validated only on a
   throwaway local Postgres) is Rob's to review. Merge-order dependency with
   Tier 0 item 6: #872 is journal idx 49 and #870 is idx 50 — #872 first, or
   bump #870's `when`.** Generic authoring emission stays #804's scope.
10. **#803 — default flip + snapshot interstitial + no-public-link invariant.**
    Next once #872 merges. **Human-owned caveat (§7 data-scoping spine):
    unattended sessions build the interstitial, the audited acknowledgment
    row, the publish-time + serve-time no-public-link invariant with its test,
    and the migration sweep behind an off-by-default flag only — the
    data-sharing default flip itself is DESCRIBED in the PR body for Rob to
    flip, never made unattended (the observe→enforce pattern of #410/#701).**
11. **#804 — authoring loop: never silently bake connected data.** Generic
    binding emission for every provider (PR #418 did Salesforce; #872 kept it
    Salesforce-only on the new shape); bake detection at save;
    preview-as-unconnected-viewer (deliberately not impersonation of a
    specific colleague). **Human-owned caveat (§7 data-scoping spine, same as
    #803): unattended sessions build detection + the warning/one-click-convert
    UX only; any behavior that BLOCKS or changes what connected data can leave
    a thread is DESCRIBED in the PR body for Rob, not enabled unattended.**
12. **#805 — per-widget tri-state contract + "Live · as you" chip.** `ok /
    needs_connection / error` per binding, per-widget `fetchedAt`, page-level
    chip and tooltips in both themes. #872's response shape already carries
    `needsConnection` + `connectionStatus`, so this is mostly presentation.
    **Caveat (§7 spine adjacency): presentation and API response shape only —
    it must not alter which data a viewer can fetch, and it must never render
    another user's numbers as any fallback state, including builder mint-time
    data (Rob decision #2 on the issue). If implementation would touch
    scoping/fallback logic, that part is DESCRIBED in the PR body for Rob, not
    made unattended.**
13. **#806 — per-viewer caching, rate limits, invalidation.** Before broad view
    traffic. The epic's one correctness landmine lives here: the cache key is
    `(appVersionId, bindingId, viewerUserId, argsHash)` and `viewerUserId` is
    never omitted; single-flight coalescing keys on the full per-user key;
    bust on disconnect/reconnect, revocation (#835's `connection.revoked`),
    and version publish. Start browser-side stale-while-revalidate; add a
    server cache only if provider rate limits demand it. The two-session
    zero-shared-bytes test is mandatory. Verify #407's per viewer+app rate
    limit holds for multi-binding pages.
14. **#807 — token-handler verification.** Anytime; a good IT-review artifact.
    Prove tokens are resolved server-side from the viewer's session only and
    never reach HTML, props, bundles, or binding responses; CSP blocks direct
    provider calls; document the path in
    `docs/security/DATA_FLOW_AND_CLASSIFICATION.md`. **Caveat: verification +
    tests only — it touches the token/auth surface, so any *behavior* change it
    uncovers is described in the PR body for Rob, not made unattended.**
15. **#808 — interim step only:** the share-time provenance warning for any
    shared artifact containing baked connected data ("contains data from your
    Salesforce as of {date}") can ship once #872 is merged. The full
    recipient-identity mechanism waits on the sharing surface (#78, parked).
16. **#810 — decision ticket, not build work.** #410 enforcement exists and
    #701's default-deny shipped (#861), but Rob's blast-radius questions
    (eligible providers/actions, admin review before publish, abuse limits)
    are unanswered. #620's propose-don't-execute is the likely v1 shape.

### Tier D — harness wave 2 (#770), re-scoped

17. **#771 — context lifecycle — stages 1–2 shipped (#882, 2026-09-04);
    the issue stays open.** Built in the order the issue asks: stale
    tool-result clearing before every provider call once the
    transcript exceeds ~160K chars (error results exempt, raw payloads kept in
    the persisted transcript and events, receipt in the `provider-request`
    snapshot), then a rolling `thread-summary.v1` document in
    `chat_threads.summary` (fire-and-forget after a successful turn,
    `resolveModelForPurpose("summaries")`, nonce-framed input and output,
    `(id, user_id)`-scoped) rendered as layer-7 background data on the next
    turn. No migration — the summary columns already existed and get their
    first writer. Both edits stay behind the ADR-0010 cache checkpoints.
    What remains on #771, deferred by #882: mid-run compaction of a single
    very long durable run (summarizing rounds inside one loop) — today that
    run is bounded by stage-1 clearing plus #841's envelope. Enabler for
    #772/#774, now unblocked.
18. **#780 — quick wins — item 1 in gate, item 2 mostly shipped.** Item 1,
    parallel tool calls in `packages/agent/src/loop.ts`: PR #892 in gate —
    the concurrent batch fires only when every call in the round resolves to
    a registered `always_allow` tool, so #833's pause-before-any-handler
    contract, per-call audit rows and #841's budget checks are untouched; the
    one review blocker (serialization inside the handler guard) was fixed at
    12:05Z and two later reviews are clean. Item 2: schedule Run-now +
    per-schedule run history shipped (#886) with the cadence-side in-flight
    guard (#894). Item 2c, the per-schedule model override, is NOT built: it
    needs `schedules.model_id` — a handwritten migration DESCRIBED in #886's
    body for Rob, not filed; it resolves through the registry and never
    touches the judge model. #893 (one live run per thread/schedule, found by
    #886's review) is the migration-shaped follow-on, Rob-gated.
19. **#773 — durable approvals, re-scoped after #833/#834.** Already shipped
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
20. **#772 — run checkpoints & rewind.** Unchanged scope; anchors on
    `run_events` (the `(run_id, sequence)` unique index exists, migration
    0037). External writes are not undoable and the UI must say so.
    Unblocked (#882 merged); after Tier E P3 and #438 in the next-session
    order.
21. **#774 — verifier pass for unattended runs.** Unchanged; it runs as a
    child run, so #842's child-run budget envelope already bounds it.
    Unblocked (#882 merged); same sequencing as #772.
22. **#775 — policy engine, re-scoped.** #841/#842 shipped the per-run
    token/USD/wall-clock/iteration envelope and #837 the presets. Remaining:
    per-user daily budget, downgrade gate, trivial→cheap classifier, risk
    score, loop watchdog, integration defaults. L, staged; after Tier C.
23. **#776 — credential-injection egress proxy.** L; rides behind Tier 0
    item 6 (#870) and is infra-shaped (§7) at the proxy layer — Rob owns the
    proxy change; unattended work is the per-skill egress-rule schema and
    tests.
24. **#777 OTel, #778 progress notes, #779 save-as-skill** — unchanged, later.

### Tier E — #797 developer-swappable brains, P1 + P2 complete

P1 shipped on 2026-09-04 (#871 + #798 + #888) and P2 the same day (#879). P3
is next. Each seam is still its own PR; nothing here adds a model, env, or IAM
unattended.

25. **P1 — open the seams — COMPLETE (#871, #798).** `supportsPromptCaching`
    / `invocation` on `ModelMetadata`, `cachePoint` blocks conditional, the
    runtime union open, the alias table registry-derived, and the identity
    line derived from `brandedName` / `providerDisplayName` /
    `olderModelExample`. Exit test met: a fake non-Anthropic Converse registry
    entry runs a full turn with zero cache blocks and a truthful identity
    line. **Leftover #856 — done (#888):** one exported `modelIdentityLine()`
    helper in `packages/agent` keyed off `MODELS` by own-property check (so
    the fake Nova exit test keeps its truthful line), `buildAgentPreamble`
    dropped its copy.
26. **P2 — qualification harness — COMPLETE (#879, 2026-09-04 12:10Z).**
    `pnpm eval --model <id>` validates against the registry, refuses the
    judge id, overrides every case-level pin, keeps `JUDGE_MODEL_ID` pinned
    separately, and emits a scorecard (`qualified` / `not-qualified` /
    `incomplete`; `--baseline` against a prior nightly report). **It PROPOSES
    the qualification bar in `docs/REGRESSION_GAUNTLET.md` (each threshold a
    named constant in `scorecard.ts`) — ratifying it is Rob's.** Built and
    tested against `--mock` only; real-model qualification runs stay
    Rob-dispatched (shared Bedrock quota, #706). It surfaced #880 (Tier 0
    open); the first nightly after it surfaced #895 (a truncated judge
    response scored as FAIL — verdict-first parse, lane in flight). #301/#302
    fold in here rather than being built as separate surfaces first.
27. **P3 — first non-Claude Converse brain (Nova), disabled by default —
    NEXT (next-session item 3).** The registry entry is unattended-safe; the
    qualification run and every enablement row are Rob's (#305: "the
    production enablement click is Rob's").
28. **P4 = #660** — Parked (IAM/env; see below). **P5** runbook right after
    P3, same session if P3 lands.

### Security spine — one per cycle, interleave with tiers above

- **#701** was this cycle's spine item — shipped (#861, Tier 0 item 3).
- **#457 — tamper-evident audit log — ADR 0014 merged (#867, 2026-09-04).**
  Design only (option (c) hash chain: additive `seq` / `prev_hash` /
  `row_hash`, a `BEFORE INSERT` trigger serialized by an advisory lock as the
  single writer, retention as a chained checkpoint, `pnpm audit:verify`).
  **Approving the ADR is not approving the build: the additive `audit_log`
  migration and option (a)'s DB role/GRANT change each get their own
  Rob-gated PR.** The issue stays open for those.
- **#443 / #448 — CLOSED 2026-09-04**, verified against `main`: fencing,
  inline reaper, `(run_id, sequence)` unique index (migration 0037) and
  bounded per-worker concurrency (`WORKER_RUN_CONCURRENCY`, default 3). The
  production task count / concurrency env stays ops (§7) — flagged, not
  flipped.
- **#868 → #873 merged.** The browser egress proxy no longer crashes on a
  client `ECONNRESET` after a denied CONNECT (found while verifying #870).
- **#695 → #869 merged.** Unit test coverage is measured in CI (the reason
  for #878's cap bump).
- **#813 → #874 merged; #853 → #855 merged** (Tier 0 addendum).
- **#708 → #883 → #889 merged; #887 closed.** CI no longer pulls a Postgres
  image from any registry (Tier 0 addendum).
- **#691 — WAF** stays in count mode until #697 gives block mode a rehearsal
  target; infra, Rob.
- **#460 data lifecycle, #381 trace retention** — later, unchanged.

### Parked / needs Rob (skip during unattended work)

- **#660 — Bedrock Mantle Responses adapter (GPT-5.6 Terra).** Needs new ECS
  task-role IAM for SigV4-signed Mantle requests plus endpoint env/config —
  Rob approvals before implementation (the issue's own gate). Sequenced as
  #797 P4 behind P2/P3 now that P1's seams are open. Direct OpenAI API stays
  out of scope.
- **#455 — split encryption and signing keys.** New env var (`SIGNING_KEY` or
  an HKDF root) + rotation runbook — Rob-gated env change.
- **#457 — tamper-evident audit log.** ADR 0014 is merged (#867).
  Implementation is Rob-gated: option (a)'s DB role/grant change
  (INSERT/SELECT-only on `audit_log`) and the additive chain migration, each
  its own PR.
- **#697 — staging environment.** AWS spend + naming/DNS + its own secrets;
  synthetic data only. Unblocks #691 block mode, #696 load tests, and
  migration rehearsal (#467).
- **#706 — CI/prod Bedrock quota isolation.** The #781 alarm fired on
  2026-08-12 at 99.5% of the Sonnet daily quota; nothing structural has
  changed. Separate eval account/role, or an independent-bucket candidate
  model with the judge pinned — account/IAM, Rob. #880 is the same decision
  seen from the judge's side.
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
- **#836 — Ping/SCIM deprovisioning → revocation.** Land when there is a real
  caller and credentials; no unwired seam in the runtime (per the #835
  review).
- **#599 — rename the truncated `workspace_artifacts` FK.** Forward migration;
  Rob approval.
- **#305 / #295 / #301 / #302 (models)** — enablement decisions are Rob's;
  build work folds into Tier E P2/P3.
- **#810** — decision ticket (Tier C item 16).
- **PRs #870 and #872** — migrations 0050 / 0049 plus #870's secret
  provisioning (Tier 0 item 6, Tier C item 9). Rob merges, #872 first. For
  #870: create the LOGIN role password and the
  `ai-workspace/production/browser-proxy-db` Secrets Manager secret BEFORE
  merging — merge = deploy.
- **#890 — close or merge** (close = keep #885's action pins, merge =
  revert); #823 closes on Rob's sign-off of the state kept either way.
- **#880 / #891** — Tier 0 open decisions (the self-judged nightly; the
  `needs-rob` verdict gate). #862 (workflow concurrency) is PR #899.
- **CodeBuild `concurrentBuildLimit=1`** — pushes during a running build are
  dropped; three merges tonight needed a manual start. Infra, Rob.
- **#893 — one live run per thread/schedule.** Unique partial index on
  `runs(schedule_id) WHERE status IN ('queued','running')` plus a per-thread
  worker fence; migration, Rob-gated. #894 guards the cadence path meanwhile.
- **#780 item 2c — `schedules.model_id`** per-schedule model override:
  migration described in #886's body, not filed. Rob's call.
- **#879's qualification bar** in `docs/REGRESSION_GAUNTLET.md` — the
  thresholds are Rob's to ratify before any real qualification run counts.
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
- **#412 / #413 / #422–#424** — GA-Pac architecture specs; unchanged.
  **#438 layered instructions is no longer parked:** #856 (#888) cleared its
  blocker; it is next-session item 4.
- **#812 docs-only CI fast lane — shipped (#877).** The classifier + summary
  jobs are on `main`; the required-check contract is Rob's to confirm on the
  docs-only PRs (#884 was the first, this update the second).
- **#744, #467, #696** — conformance suite, release engineering, load tests
  (needs #697): later. (#695 coverage shipped, #869; #708 Docker Hub pulls
  closed by #883 → #889.)

## Notes

- #830 stays open as the alert thread; #847 was the fix ticket and shipped as
  #857. The bar — 20 consecutive clean scheduled samples per marked
  assertion, counted from #857 — is unchanged, and Rob closes #830 and lifts
  the #847 markers together. #866's `#860` marker on
  `scope-honesty-send-email` is a separate known-red with its own fix ticket.
  The 11:48Z scheduled nightly's single red sample
  (`salesforce-faithfulness/injection-fake-tool-result`) is #895 — the
  judge's own rationale said PASS, then hit the output-length continuation
  notice and the verdict was not parsed. Fix lane: verdict-first judge
  prompt, robust parse, truncated-without-verdict → inconclusive + one
  bounded re-sample, `judgeTruncated` flag in the nightly comment.
- Open PRs on 2026-09-04 12:40Z, in merge order: #872 (Rob, migration 0049)
  → #870 (Rob, migration 0050 + secret); #890 (Rob decision, held); #892 in
  the gate and human-gating nothing. No PR for #895 yet.
- UI/UX epic #762, harness epic #770, viewer-identity epic #801, and Studio
  epic #735 are tracking umbrellas; their actionable children are tiered
  individually above.
- The August research record (sources for Tiers C/D) lives in
  `docs/research/HARNESS_RESEARCH_2026-08.md`; viewer-identity decisions are
  on #801; the tool-policy decision record is ADR-0011 (refreshed by #854);
  the audit-log chain design is ADR-0014 (merged as #867).
- goal.md's guard on PR #272 / issue #291 (SES) is unchanged and still
  binding.
