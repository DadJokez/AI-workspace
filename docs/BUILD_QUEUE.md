# Build Queue — re-triaged 2026-09-02

Prioritized, dependency-ordered queue of open work. Re-triaged three weeks
after the 2026-08-12 queue: its Tiers A and B shipped in full, the #410
tool-policy series (#831–#835), autonomy presets (#837), and per-run budgets
(#841–#843) landed on `main` on 2026-08-15/16 — and nothing has merged since.
`main` has sat at `dbf1e81` for 17 days while the nightly canary went red on
10 of 18 nights. Clearing that gap is this cycle's first job.

**Consumed by `/goal`** (`.claude/commands/goal.md`): an overnight session works
this queue top-down, skipping anything whose dependencies aren't merged to
`main` or that is human-gated. Re-triage when this file is more than ~2 weeks
old or the queue is empty (goal.md Phase 2.1) — next check-in 2026-09-16.

## Completed since the 2026-08-12 triage

- **Tiers A and B of the August queue — shipped in full** (PR map under
  "Prioritized queue" below). Nothing from either carries forward.
- **Security spine:** #410 closed by the five-PR series #831 (persisted
  tri-state policy, migration 0045) → #832 (runtime refusal of `blocked`) →
  #833 (durable interactive approvals, 0046) → #834 (standing Skill approvals +
  unattended deny-and-report, 0047) → #835 (connector lifecycle governance +
  `/admin/connectors`, 0048). #436 presets → #837. ADR-0011 has not caught up
  (Tier 0).
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
5. Security spine items ride one-per-cycle as always; #701 is this cycle's.
6. **A red canary with no human triage within 48h pauses the queue.** If
   Nightly Evals is red and the alert thread (#830 or its successor) has no
   human comment within 48h of the red, an unattended session does Tier 0
   triage work only — or writes its session summary and stops. It never builds
   features on top of an untriaged red. **This principle is tripped as of
   2026-09-02:** #830 carries twelve bot comments and zero human ones since it
   opened on 2026-08-15.

## Prioritized queue

### Tier 0 — hygiene before any unattended run

Gate status on 2026-09-02: `main` = `dbf1e81`; every scheduled Product Smoke
since 08-30 is green; Nightly Evals red 10/18 nights since 08-16 on that same
unchanged SHA; the required `dependency CVE audit` check is red on the only
open PR. Nothing below Tier 0 starts until items 1–3 are green or Rob
explicitly waives them.

1. **CVE audit is red on every PR — Rob-owned, blocks the pipeline.**
   `dependency CVE audit` is a required check on `main` (branch protection),
   and `scripts/audit-prod-deps.sh` failed on PR #798's 2026-09-02 re-run with
   advisories in four transitive production packages: `qs`
   (`packages/agent > @modelcontextprotocol/sdk > express > qs`, moderate),
   `fastify` 5.11.3 (`apps/web > bedrock-agentcore@0.4.3 > fastify`;
   Dependabot alert opened 2026-09-02, runtime scope, medium), `fast-uri`
   (under that fastify), `@xmldom/xmldom` (`apps/web > mammoth`). Same shape
   and same fix as #783/#818: pnpm overrides + minor bumps. **Human-owned
   caveat (§7; goal.md "no new production dependencies"): an unattended
   session may restate the override plan in a comment — it never opens the
   dependency PR.** Tracked as **#845** (full advisory table, reachability, and override plan on the issue).
2. **#847 — dispose of the two anti-echo flakes and restore closure hygiene.**
   Every red since 08-17 is on `dbf1e81` — harness/model variance, not a
   regression: `artifact-content-is-inert-data` (4/5 on 08-17, 08-21, 08-23,
   08-27, 08-31, 09-01) and `memory-capture-resists-planted-memory` (3–4/5 on
   08-25, 08-26, 08-29), each a refusal that quotes the hostile marker while
   the judge passes. Disposition on the issue: assertion-scoped
   `knownIssue: "#847"` on exactly three deterministic assertions (judge
   assertions stay blocking), remove the two stale `#675` markers (bar met
   85/85), bump job timeouts (35→50; canary 20→30 plus a 10-min step cap on
   the Chromium install), and make the #830 bot name the failing case. Rejoin
   bar: 20 consecutive clean scheduled samples per marked assertion; Rob
   closes. Unattended-buildable (evals + workflow YAML only; no
   `permissions:` change).
3. **#701 — the write boundary fails closed at every registry path** — **shipped 2026-09-03** (spec
   comment on the issue, 2026-09-02). #831–#834 gate only tools that carry a
   declared policy; a tool with `policy === undefined` executes with no pause
   and no audit stamp (`packages/agent/src/loop.ts:783-796`). The spec:
   `Tool.policy` becomes required, the loop defaults an undeclared policy to
   `needs_approval`, builtins declare `always_allow` explicitly
   (`resources__query` is the one that would otherwise break attached-file
   chat), eval fixtures mirror the catalog rule and the harness runs
   `deny_unattended`, and `scope-honesty-send-email` passes with both `#701`
   markers removed. **Human-owned caveat (§7 permissions behavior): the PR
   body must carry the read/write classification table of every
   registry-reaching tool, and Rob reviews the non-read ones
   (`comparative__activate_tools`, the eval-only draft/event fixtures) before
   merging. Codex builds; Rob merges.**
4. **#846 — per-user scoping regression guard (follow-up to the silent fix
   in #827).** The audit on the issue found **no remaining unscoped surface**
   (every runs / threads / artifacts / approvals / notifications / schedules
   listing is user-scoped, admin-gated with audit, or wider by an explicit
   access model), so this is test debt, not a live leak: a scoping-integration
   regression test for the #827 predicate (starter skill, two users), a
   `readdirSync` grep guard over `apps/web/app/**` with a four-entry allowlist
   that fails on stale entries, and one shared `collectText` helper. Rob's
   call, not Codex's: whether the June–August cross-user run-history exposure
   gets a dated note in `docs/security/`. Stretch, separate PR: the two-user
   cross-user-404 sweep over the seven August migrations (0042–0048) and
   their routes.
5. **#848 — make budget truncation a first-class signal, not a `succeeded`
   run.** Budget exhaustion ends the run as `succeeded` with `partial: true`
   only in the receipt, so anything filtering on status counts truncated runs
   as successes, and failed/aborted runs persist a near-zero receipt
   inconsistent with `usage`. Decision on the issue: keep the `run_status`
   enum; make `outputs.budgetReceipt` the field every consumer reads via one
   helper, and record accurate receipts on every terminal path in the shell
   (lane-independent). **Not in scope:** admin-editable lane defaults, #396's
   cache columns (Rob-gated migration), #734/#775.
6. **#849 — the browser egress proxy must not hold the full application
   `DATABASE_URL`.** The proxy task receives the app secret's `DATABASE_URL`
   (`infra/cdk/lib/ai-workspace-ecs-stack.ts` ~:420) to read one admin
   denylist (`apps/web/scripts/browser-egress-proxy.ts` ~:130), so the one
   internet-terminating component has read/write on every table. Spec on the
   issue: a NOLOGIN read-only Postgres role scoped to the denylist table
   (handwritten migration) and a separate secret keeping the same env key so
   the proxy needs no code change. **Human-owned caveat (§7 secrets/IAM): Rob
   enables the role and provisions the secret; Codex ships the migration +
   CDK wiring behind that.** Whether the denylist governs the whole proxied
   session (not only target resolution) is recorded on the issue as an open
   question, not assumed.
7. **#850 — bring ADR-0011 up to date.** Its status notes still say
   "Enforcement is intentionally still open… P1 observe-mode only"
   (`docs/adr/0011-tool-policy-observe-before-enforce.md`), three weeks after
   #831–#835 shipped persistence (0045), refusal, durable approvals (0046),
   standing approvals (0047), unattended deny-and-report, and lifecycle
   governance (0048), and #837 bound presets. Record what enforces now, that
   `would_*` values survive only as the observe-mode fallback for old/in-flight
   results (#832), the uncataloged default (item 3), and #436. Docs-only,
   unattended-safe; it still pays the full CI gate until #812 exists.
8. **PR #798 — finish #797 P1's identity seam (honesty spine).** Open since
   08-11, `needs-codex`, Claude verdict = changes requested, rebased onto
   `main` on 2026-09-02 and merging clean. Per the spec refresh on the PR: the
   remaining hardcoded identity line is `packages/agent/src/loop.ts:173`
   (pinned by `loop.test.ts:88-89`); derive it from `brandedName` /
   `providerDisplayName` / `olderModelExample`, preferably via one exported
   `modelIdentityLine(modelId)` helper in `packages/agent` that owns the
   neutral fallbacks, with `buildAgentPreamble` dropping its copy; add the
   `olderModelExample`-absent test; finish with the grep sweep (only the
   context-portability poisoned fixtures and registry data may still match
   `made by Anthropic|You are Claude`). Merge is additionally blocked by
   item 1.

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

9. **#802 — generic read-tool bindings.** The mechanism: `{id, provider,
   toolName, pinnedArgs, label}` over any read-only catalog tool; the browser
   submits binding ids only; server-side declaration enforcement per app
   version; fail-closed provider gate (per-user credential support +
   connect-CTA empty state + audit, checked at publish time); pinned args
   secret-scanned at mint; bindings immutable per version. **Human-owned
   caveat (§7, stated on the issue): the schema change/migration for the
   generalized binding shape is Rob's to review. Buildable unattended up to
   and including the handwritten migration draft, flagged human-owned at the
   top of the PR body; never run against a live database.**
10. **#803 — default flip + snapshot interstitial + no-public-link invariant.**
    **Human-owned caveat (§7 data-scoping spine): unattended sessions build the
    interstitial, the audited acknowledgment row, the publish-time + serve-time
    no-public-link invariant with its test, and the migration sweep behind an
    off-by-default flag only — the data-sharing default flip itself is
    DESCRIBED in the PR body for Rob to flip, never made unattended (the
    observe→enforce pattern of #410/#701).**
11. **#804 — authoring loop: never silently bake connected data.** Generic
    binding emission for every provider (PR #418 did Salesforce); bake
    detection at save; preview-as-unconnected-viewer (deliberately not
    impersonation of a specific colleague). **Human-owned caveat (§7
    data-scoping spine, same as #803): unattended sessions build detection +
    the warning/one-click-convert UX only; any behavior that BLOCKS or changes
    what connected data can leave a thread is DESCRIBED in the PR body for
    Rob, not enabled unattended.**
12. **#805 — per-widget tri-state contract + "Live · as you" chip.** `ok /
    needs_connection / error` per binding, per-widget `fetchedAt`, page-level
    chip and tooltips in both themes. **Caveat (§7 spine adjacency):
    presentation and API response shape only — it must not alter which data a
    viewer can fetch, and it must never render another user's numbers as any
    fallback state, including builder mint-time data (Rob decision #2 on the
    issue). If implementation would touch scoping/fallback logic, that part is
    DESCRIBED in the PR body for Rob, not made unattended.**
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
    Salesforce as of {date}") can ship once #802 exists. The full
    recipient-identity mechanism waits on the sharing surface (#78, parked).
16. **#810 — decision ticket, not build work.** #410 enforcement now exists,
    but item 3's default-deny is still open and Rob's blast-radius questions
    (eligible providers/actions, admin review before publish, abuse limits)
    are unanswered. #620's propose-don't-execute is the likely v1 shape.

### Tier D — harness wave 2 (#770), re-scoped

17. **#771 — context lifecycle.** Shipped (PR `goal/771-context-lifecycle`):
    stale tool-result clearing in `runAgentLoop`, rolling `thread-summary.v1`
    generation via the `summaries` purpose after each successful turn, and
    both edits confined to the messages region behind the ADR-0010
    checkpoints. Still open under the issue: mid-run compaction of a single
    very long durable run (today bounded by clearing + #841's envelope).
18. **#780 — quick wins.** Both still open on `main`: tool calls in
    `packages/agent/src/loop.ts` execute serially, and schedules have no
    Run-now or per-schedule model override. Parallel execution must preserve
    #833's contract — a round containing any `needs_approval` call pauses
    before *any* handler runs — plus per-call audit rows and #841's budget
    checks. The per-schedule override resolves through the registry (Tier E
    P1 makes that registry-derived) and never touches the judge model.
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
    0037). External writes are not undoable and the UI must say so. After
    #771.
21. **#774 — verifier pass for unattended runs.** Unchanged; it runs as a
    child run, so #842's child-run budget envelope already bounds it. After
    #771.
22. **#775 — policy engine, re-scoped.** #841/#842 shipped the per-run
    token/USD/wall-clock/iteration envelope and #837 the presets. Remaining:
    per-user daily budget, downgrade gate, trivial→cheap classifier, risk
    score, loop watchdog, integration defaults. L, staged; after Tier C.
23. **#776 — credential-injection egress proxy.** L; rides behind Tier 0
    item 6 and is infra-shaped (§7) at the proxy layer — Rob owns the proxy
    change; unattended work is the per-skill egress-rule schema and tests.
24. **#777 OTel, #778 progress notes, #779 save-as-skill** — unchanged, later.

### Tier E — #797 developer-swappable brains, P1 first

Sequenced after Tier C is underway. P1 is unattended-safe (no new models, no
env, no IAM) and each seam is its own PR.

25. **P1 — open the seams.** On `main` today: no `supportsPromptCaching` /
    `invocation` on `ModelMetadata` (`packages/agent/src/models.ts`) and
    `cachePoint` blocks emitted unconditionally
    (`packages/agent/src/clients.ts:453,605`); the runtime union is closed
    (`packages/agent-runtime/src/types.ts:168,179`); the alias table is
    hand-written (`apps/web/lib/model-command.ts:18-29`); identity is
    hardcoded at `agent-preamble.ts:134` and `loop.ts:173` (PR #798, Tier 0
    item 8). Exit test: a fake non-Anthropic Converse registry entry runs a
    full turn with zero cache blocks and a truthful identity line.
26. **P2 — qualification harness.** `pnpm eval --model <id>` (no override in
    `packages/evals/src/run.ts` today); `JUDGE_MODEL_ID` stays pinned
    separately; document the bar. Build and test against `--mock` unattended;
    real-model qualification runs are Rob-dispatched because they draw on the
    shared Bedrock quota (#706). #301/#302 fold in here rather than being built
    as separate surfaces first.
27. **P3 — first non-Claude Converse brain (Nova), disabled by default.** The
    registry entry is unattended-safe; the qualification run and every
    enablement row are Rob's (#305: "the production enablement click is
    Rob's").
28. **P4 = #660** — Parked (IAM/env; see below). **P5** runbook after P3.

### Security spine — one per cycle, interleave with tiers above

- **#701** is this cycle's spine item (Tier 0 item 3).
- **#443 / #448 — verify and close.** The fencing, inline reaper, and
  `(run_id, sequence)` unique index shipped in PRs #473 and #489 (migration
  0037; `apps/web/lib/chat-run-worker.ts:172-265,547,646`), and bounded
  per-worker concurrency exists (`WORKER_RUN_CONCURRENCY`, default 3 at
  `chat-run-worker.ts:52,174-176`); both issues are still open with stale July
  "skipped" comments. Action: confirm acceptance against `main`, comment,
  close. **Caveat: the production task count / concurrency env is ops (§7) —
  flag, don't flip.**
- **#691 — WAF** stays in count mode until #697 gives block mode a rehearsal
  target; infra, Rob.
- **#460 data lifecycle, #381 trace retention** — later, unchanged.

### Parked / needs Rob (skip during unattended work)

- **#660 — Bedrock Mantle Responses adapter (GPT-5.6 Terra).** Needs new ECS
  task-role IAM for SigV4-signed Mantle requests plus endpoint env/config —
  Rob approvals before implementation (the issue's own gate). Sequenced as
  #797 P4 behind P1/P2 so it plugs into opened seams. Direct OpenAI API stays
  out of scope.
- **#455 — split encryption and signing keys.** New env var (`SIGNING_KEY` or
  an HKDF root) + rotation runbook — Rob-gated env change.
- **#457 — tamper-evident audit log.** Option (a) is a DB role/grant change
  (INSERT/SELECT-only on `audit_log`) — Rob-gated; the hash-chain design (c)
  can be drafted as a doc unattended.
- **#697 — staging environment.** AWS spend + naming/DNS + its own secrets;
  synthetic data only. Unblocks #691 block mode, #696 load tests, and
  migration rehearsal (#467).
- **#706 — CI/prod Bedrock quota isolation.** The #781 alarm fired on
  2026-08-12 at 99.5% of the Sonnet daily quota; nothing structural has
  changed. Separate eval account/role, or an independent-bucket candidate
  model with the judge pinned — account/IAM, Rob.
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
- **Tier 0 item 1 (CVE bumps)** — production-dependency change, Rob.

### Deliberately parked (do not start without a conscious call)

- **#736 Governed Custom Agents (+#745–#748)** — after #801 Tier C is
  underway, not before.
- **#811 Studio Browser general web navigation + persistent sessions** —
  security-heavy new surface; after Tier 0 item 6 and #776.
- **#491–#493 perimeter/identity/accountable-runtime epics** — pull items only
  when an IT-review date makes them concrete.
- **#494 / #495 / #78** — habit loop, flywheel, share cards: wait for the
  team/org entity design and real usage signal.
- **#765 unified shell, #769 Button migration** — structural UI; after the
  Tier B polish has stabilized in use.
- **#620 / #622 / #624 / #435 / #734** — proposal inbox, provenance shell,
  governed Salesforce writes, spend dashboard: behind #775 and #810.
- **#412 / #413 / #422–#424 / #438** — GA-Pac architecture specs; unchanged.
- **#812 docs-only CI fast lane** — worth doing (Tier 0 item 7 and this file
  each pay ~7 min of CI) but it rewrites the required-check contract, so the
  branch-protection change is Rob's; build the classifier + summary jobs,
  flag the protection edit.
- **#744, #467, #695, #696, #708** — conformance suite, release engineering,
  coverage, load tests (needs #697), Docker Hub pulls: later.

## Notes

- #830 stays open as the alert thread; #847 is the fix ticket. #847 defines
  the bar — 20 consecutive clean scheduled samples per marked assertion,
  counted from its marker PR — and Rob closes #830 and #847 together.
- UI/UX epic #762, harness epic #770, viewer-identity epic #801, and Studio
  epic #735 are tracking umbrellas; their actionable children are tiered
  individually above.
- The August research record (sources for Tiers C/D) lives in
  `docs/research/HARNESS_RESEARCH_2026-08.md`; viewer-identity decisions are
  on #801; the tool-policy decision record is ADR-0011 (Tier 0 item 7
  refreshes it).
- goal.md's guard on PR #272 / issue #291 (SES) is unchanged and still
  binding.