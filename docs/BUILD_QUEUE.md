# Build Queue — triaged 2026-07-06

Prioritized, dependency-ordered queue of open work, produced from a full triage
of the 17 open issues, [`PLAN.md`](../PLAN.md), [`docs/ROADMAP.md`](ROADMAP.md),
[`docs/BRAINSTORM_2026-07.md`](BRAINSTORM_2026-07.md) (committed 90-day
direction), and [`docs/STRETCH_GOALS_2026-07.md`](STRETCH_GOALS_2026-07.md).

**Consumed by `/goal`** (`.claude/commands/goal.md`): an overnight session works
this queue top-down, skipping anything whose dependencies aren't merged to
`main` or that is human-gated. Re-triage when this file is more than ~2 weeks
old or the queue is empty.

## Triage summary

| Issue | Title (short) | Verdict | Blocked by |
|---|---|---|---|
| #292 | Notification center + daily digest | **Ready** | — |
| #304 | Context-portability eval | **Ready** | — |
| #299 | Gmail/Calendar faithfulness evals | **Ready** | — (merge before/with #297) |
| #300 | Generalize model registry | **Ready** | — |
| #293 | GitHub webhook event triggers | Ready after dep | #292 merged |
| #297 | Gmail + Calendar Gateway integration | Ready to code | Live test needs Rob's Google OAuth credentials |
| #301 | Model qualification pipeline | Ready after dep | #300 merged |
| #302 | Admin model page | Ready after deps | #300 + #301 merged |
| #303 | Router model selection in lanes | Ready after dep | #300 merged |
| #298 | Meeting Prep + Weekly Status skills | Ready after dep | #297 merged |
| #305 | Enable first non-Anthropic models | Rob-gated | #300–#303 + Rob's enablement click |
| #291 | SES production invite email | **Rob-gated (ops)** | AWS Support case 178191850800335 state mismatch; PR #272 waits |
| #295 | [EPIC] Model qualification | Tracking only | children #300–#305 |
| #294 | [EPIC] Integration factory | Tracking only | children #297–#299 (#296 done) |
| #27 | [EPIC] Scheduled agents | Housekeeping | close when #292/#293 land (see notes) |
| #133 | [EPIC] J4/J5 app lifecycle | **Needs grooming** | children #172–#175 all closed — see spec below |
| #78 | Shared AI work cards | **Deferred + needs grooming** | team/org entity doesn't exist — see spec below |

The two epics' child issues (#297–#299, #300–#305) are unusually well-groomed —
scoped, with acceptance criteria, out-of-scope lists, and human-gate flags.
They are the backbone of the queue. The grooming gaps are elsewhere: two
high-value items called out in the July brainstorm that were **never filed**
(web search, artifact-revision consolidation), one epic whose children are all
closed (#133), and one deferred feature missing its prerequisite (#78).

## Prioritized queue

Ordered by value ÷ risk, respecting dependencies and the committed 90-day
sequence (delivery loop → integration factory → model substrate).

### Tier A — start tonight (independent, locally verifiable)

1. **#292 — Notification center + daily digest.** The committed plan's
   "biggest perceived-value jump" and the substrate for the north-star metric
   (accepted proactive work/user/week). Self-contained; `notifications` table
   migration is explicitly scoped in the issue (flag as human-owned in the PR).
2. **#304 — Context-portability eval.** Smallest-risk item on the board:
   deterministic deny-list checker in `packages/evals`, wired into CI, plus
   cleanup of any current violations. Independent of everything.
3. **#299 — Gmail/Calendar faithfulness evals.** Evals are data, not code —
   fixture-backed cases for injection resistance, attestation/empty-result/
   disconnected/scope honesty. Zero product-code risk, and it must merge
   before or with #297, so doing it first unblocks the integration.
4. **#300 — Generalize the model registry.** Foundation that unlocks four
   downstream issues (#301–#303, #305). Explicit no-behavior-change acceptance
   criterion makes it safely verifiable by the existing suite. Migration
   scoped in the issue (flag for Rob).

### Tier B — unblocks as Tier A merges

5. **#293 — Event triggers (GitHub webhooks)** — after #292 is on `main`.
6. **#297 — Gmail + Calendar integration** — code + tests can land against the
   spec now; live verification and the consent screen are Rob's. Prefer to
   start after #299 is merged.
7. **#301 — Qualification pipeline** — after #300.
8. **#302 — Admin model page** — after #300 + #301.
9. **#303 — Router selection within lanes** — after #300 (#302 surfaces its events).
10. **#298 — Meeting Prep + Weekly Status skills** — after #297.

### Tier C — Rob-gated, not overnight work

- **#291 (SES)** — AWS Support says production access approved; live APIs say
  sandbox/DENIED. Only Rob can work the support case. PR #272 stays open until
  API state matches. **`/goal` must not touch this.**
- **#305** — final qualification + enablement run; enablement click is Rob's.

### Housekeeping recommendations (Rob decisions, 5 minutes)

- **#27**: scheduling shipped June 2026; the two remaining scope items are now
  tracked better elsewhere (#292/#293 for delivery+triggers, #291 for SES).
  Recommend closing #27 in favor of those once #292/#293 land.
- **#295 / #294**: keep open as tracking epics; no direct work.
- **#133**: children all closed — verify epic acceptance criteria and either
  close or re-scope to phase 2 (spec below).

---

## Grooming specs — unfiled or under-specified work

Ready to be filed as issues after Rob's review. Written to the same standard
as the #294/#295 children.

### G1. Web search tool (unfiled — Horizon 1 in the brainstorm)

**What.** A `web__search` tool beside the existing SSRF-hardened
`web__fetch_url`: query in → ranked results (title, URL, snippet, retrieval
timestamp) out. The one consumer-parity capability every alpha tester expects
(per `docs/DESKTOP_PARITY_BACKLOG.md`), and a hard dependency for the Deep
Research stretch goal (#11).

**Human gate first.** Search requires an external provider (Brave Search API,
Tavily, or Google Programmable Search — AWS has no native web-search API).
That means a new production dependency (or plain HTTPS call), an API key in
Secrets Manager, and an env change — all human-owned per AGENTS.md. **Rob picks
the provider and provisions the key before implementation starts.** Lean
recommendation: Brave Search API (flat pricing, no GCP dependency, simple REST
— callable with plain `fetch`, no new package needed).

**Scope.**
- Tool registration following the existing web-fetch pattern (same package,
  same registration path), governed identically: audit rows per call, rate
  limiting via `rate_limit_buckets` patterns.
- Results are untrusted data: nonce-frame the full result set (snippets are an
  injection surface — same discipline as `lib/artifact-context.ts`).
- Result URLs compose with `web__fetch_url` for follow-up reads; search itself
  never fetches pages.
- Honest failure modes: provider down / quota exhausted / zero results each
  produce a truthful statement, never fabricated results.
- Config: `WEB_SEARCH_PROVIDER` + secret; tool hidden (not erroring) when
  unconfigured, and the assistant answers capability questions honestly in
  both states.

**Out of scope.** Multi-provider abstraction (one provider, YAGNI); image/news
verticals; auto-search-on-every-turn heuristics; result caching.

**Edge cases.** Empty query; non-English queries; provider 429s (backoff, then
honest failure); snippets containing instruction-shaped text (eval); very long
queries (truncate with note).

**Data/API changes.** No schema change. One secret + one env var (human-owned).
Optional `tools_catalog` row if web tools are catalog-governed — match
whatever `web__fetch_url` does today.

**Tests.** Unit: provider client with mocked HTTP (results mapping, error
paths, nonce framing present). Evals (per the bug→regression rule):
snippet-injection resistance (≥2 variants), zero-results honesty,
unconfigured-state capability honesty. No live-API tests in CI.

### G2. Artifact revision semantics consolidation (unfiled — the #1 repeat offender)

**What.** Five bugs on the same surface in June (#242, #244, #256, #276, #284
— four separate PRs). The brainstorm flags this as a mandatory consolidation
pass **before** J4 phase 2 or Projects stack more semantics on it. This is a
refactor-with-characterization-tests issue, not a feature.

**Scope.**
- Write down the invariants first, as a short doc section (in
  `docs/ARCHITECTURE.md` or a new `docs/ARTIFACT_REVISIONS.md`): what is a
  version group; which artifact is "the visible original"; when does a
  revision edit-in-place vs. create a new version; what happens on thread
  reopen; how version pills map to versions.
- Characterization tests before any refactor: one named test per historical
  bug (#242, #244, #256, #276, #284), reproducing the original failure
  scenario and pinning the fixed behavior. Playwright for the UI-visible ones
  (revision pills, reopen-thread stall), vitest for the state transitions.
- Consolidate: a single module owns revision-target resolution and version
  state transitions (today the logic is spread across the artifact routes/
  components — every fix landed in a different place, which is why it keeps
  breaking). No behavior change; the suite from step 2 proves it.
- If contradictory behaviors are discovered mid-consolidation (two code paths
  answering "which version do I revise?" differently), the invariants doc is
  the tiebreak; note the resolution in the PR.

**Out of scope.** New revision features; artifact storage move to S3 (separate
enterprise-gate item); app-version semantics (#172–#174 shipped, different
tables).

**Acceptance criteria.**
- All five historical bugs have named, passing regression tests.
- Revision-target resolution exists in exactly one module; grep proves no
  duplicate resolution logic remains.
- Invariants documented; `pnpm test` + `pnpm smoke:browser` green with no
  user-visible behavior change.

**Tests.** The characterization suite *is* the deliverable — see scope.

### G3. #133 phase 2 — J4 conversational build-iterate loop (epic re-groom)

**Status check first.** All four groomed children (#172–#175) are closed: the
version/edit-session data model, edit-from-live, deploy/rollback with stable
URLs, and viewer/editor invites all shipped. The epic's own V1 acceptance
criteria appear fully met. **Recommendation: verify the epic's acceptance-
criteria checklist against `main` (30 min), close #133, and file phase 2
fresh** — an epic whose listed work is all done no longer directs anything.

**Phase 2 spec (the brainstorm's "biggest value unlock"): the conversational
iterate loop.** What shipped is the machinery (sessions, versions, deploy,
rollback); what's missing is the *experience*: a non-developer saying "make
the header blue and add a totals row" and watching the app change.

- **Scope.** From an app's detail page, "Edit with Comparative" opens (or
  resumes) the app's edit-session thread with app context injected (current
  live version content, app metadata, version history summary — the #173
  injection path). Each assistant response that produces revised app HTML
  auto-saves as a draft version linked to the session, with a preview
  affordance and a "Deploy update" action inline in the thread (reusing #174's
  deploy path and its audit). Draft pile-up is handled: N drafts in a session
  collapse to the latest with history intact.
- **Hard prerequisite.** G2 (artifact-revision consolidation) lands first —
  this feature stacks directly on the revision surface that produced five
  June bugs.
- **Out of scope.** Multi-user concurrent editing (lock exists), git/pipeline
  substrate (V2 direction in the epic), living-apps data contracts (stretch
  goal #4).
- **Acceptance criteria.** A user with a deployed app iterates it twice in
  one conversation and deploys; the live URL serves the update; rollback to
  the pre-session version works; drafts never overwrite production; the whole
  loop is audited; Playwright covers edit→preview→deploy→rollback.
- **Tests.** Playwright e2e for the loop; vitest for draft-version linking and
  session-resume logic; eval case for honest behavior when app content
  exceeds context (say so, don't silently truncate).

### G4. #78 shared work cards — prerequisite gap (keep deferred)

The issue body is already close to a spec (data shape, guardrails, acceptance
criteria all present). Two real gaps keep it **not ready**:

1. **No team/org entity exists.** Every visibility level (`anonymous_team`,
   `named_team`, `org`) references tables that don't exist. Prerequisite
   issue to file when the time comes: `teams` + `team_members` (+ org
   singleton or `orgs` if multi-tenant shape is decided), with the
   brainstorm's "tenant-shape three things when touched" rule applied. This
   prerequisite also gates stretch goals #6 (org brain) and #8 (channel
   scoping), so it should be designed once, deliberately — not as a side
   effect of share cards.
2. **"Useful work detection" is unspecified.** V1 lean: no detection — a
   manual "Share this as a card" action on completed runs/threads, drafted by
   the assistant on request. Detection heuristics are a follow-on once cards
   exist.

Correctly sequenced after real usage exists (Horizon 3). No action tonight.

### G5. Backlog items pending from PLAN.md (unfiled, one-liners)

- **Rolling summary generation** — the summary schema/helper shipped; the
  generator never did. Scope: on-threshold background summarization on the
  memory-worker lane writing `chat_threads.summary`, honesty-eval case that
  summaries never inject fabricated facts. Medium value (long-thread quality +
  token cost) — worth filing.
- **Shared quota store + daily token budgets** — enterprise-gate track
  ("one gate item per cycle"). Rate limits are process-local today; quotas
  need a shared store. File when its gate slot comes up.
- **Dependency audit clean state** — `pnpm audit --prod` transitive findings;
  recheck before IT review. Ops chore, not a build item.
