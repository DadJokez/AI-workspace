# Build Queue — re-triaged 2026-08-12

Prioritized, dependency-ordered queue of open work. Re-triaged after the
August research wave (UI/UX epic #762, harness wave 2 #770, viewer-identity
apps #801) and the Contribution Studio tranche (#749–#761) landing on `main`.

**Consumed by `/goal`** (`.claude/commands/goal.md`): an overnight session works
this queue top-down, skipping anything whose dependencies aren't merged to
`main` or that is human-gated. Re-triage when this file is more than ~2 weeks
old or the queue is empty.

## Completed since the 2026-07-10 triage

- Contribution Studio first slices: queued follow-ups (#750), Context Shelf
  (#751), Studio shell (#752), conformance contracts (#753), Studio launcher
  palette (#754), artifact review modes (#761).
- Hardening tranche items from #453 Track A/B, AgentCore substrate deployment,
  ECS cutover, security perimeter fixes (#727–#732 series).
- The July queue's Tier A (#344, #330, #301-adjacent, #349, #348) is done or
  superseded; #301/#302 remain open under #295 and are re-tiered below.
- **Disposition of the July queue's human-gated Tier C:** both gates resolved
  and closed completed — **#297** (Gmail + Calendar integration) on
  2026-07-10 and **#291** (SES production invites, AWS case
  178191850800335) on 2026-07-11; PR #272 closed unmerged on 2026-07-08.
  Neither carries forward as queue work. **Guard note:** the
  `.claude/commands/goal.md` guard "Do not touch PR #272 or issue #291
  (SES)" **stays in place** — it protects a production email path, so any
  change to it is Rob's call under CLAUDE.md §7, not a queue to-do.
  Unattended sessions continue to honor it as written.

## Triage principles this cycle

1. **Fix what's broken and visible before building new** — the work demo
   created an audience; regressions burn trust fastest.
2. **Restore the quality signals** — the nightly eval red (#733/#782) masks
   real regressions; a permanently red canary is worse than none.
3. **Finish the in-flight epic before opening the next** — Contribution Studio
   (#735) has open tracks; Governed Custom Agents (#736) stays parked.
4. **Then the strategic swing:** viewer-identity apps (#801) is the sharing
   growth surface, sequenced #802 → #803/#804 → #805/#806.
5. Security spine items ride one-per-cycle as always.

## Prioritized queue

### Tier A — now: broken, visible, or signal-restoring (all unblocked, S/M)

1. **#795 — "Address with Comparative" FK ordering bug.** A just-shipped
   flagship interaction (#761) fails every time. Highest embarrassment-per-day.
2. **#763 — composer bricks when /api/models blips.** P1: one transient error
   = dead product with no retry for a non-technical user.
3. **#796 — false "official verification" claims on calendar artifacts.**
   Honesty is the product spine; this is a direct spine violation (HIGH).
4. **#782 — nightly eval false reds.** Fix the day-count extractor first
   (deterministic red), then the three flaky graders. Acceptance: three green
   nights. Restores the canary that gates everything else.
5. **#783 — clear the 11 Dependabot alerts.** 30–60 min of pnpm overrides +
   MCP SDK minor bump; "zero open alerts" for the next IT conversation.
6. **#759 — flaky Playwright turn-queue test.** Unblocks clean CI on every PR.
7. **#785 — rate-limit artifact review comment creation.** Small security
   follow-up to #761.

### Tier B — next: finish Contribution Studio + trust-critical UX (M)

8. **#739 — deliverable review mode: anchored comments, version diff.**
   Completes the Studio review loop started by #761.
9. **#741 — branch this work.** The remaining Studio track with the clearest
   user story.
10. **#764 — error legibility + shared toast.** The biggest systemic UX gap
    from the August review; danger tokens exist, failures are invisible.
11. **#766 + #767 — Skills/chat polish S-items.** Stale "(soon)" copy, raw
    model IDs, "/" and "@" discoverability — trust and adoption for pennies.
12. **#743 — layered guardrails visibility in Studio.** Last Studio track;
    pairs with #775 later.
13. **#768 — accessibility wave (tour focus trap first).** The first thing
    every new user meets.

### Tier C — the strategic swing: viewer-identity apps (#801), in order

14. **#802 — generic read-tool bindings.** The mechanism. **Buildable
    unattended up to and including the schema migration draft; the migration
    itself must be reviewed by Rob before merge** (CLAUDE.md §7). An
    overnight session may implement and open the PR, flagged for that review.
15. **#803 — default flip + snapshot interstitial + no-public-link invariant.**
16. **#804 — authoring loop: never silently bake connected data.**
17. **#805 — per-widget tri-state + "Live · as you" chip.**
18. **#806 — per-viewer caching/rate limits.** Before broad view traffic.
19. **#807 — token-handler verification.** Anytime; good IT-review artifact.

### Tier D — harness wave 2 picks (highest leverage first)

20. **#771 — context lifecycle (rolling summaries + tool-result clearing).**
    The oldest pending gap in PLAN.md and the enabler for durable runs.
21. **#780 — harness quick wins (parallel tool calls; schedule Run-now +
    model override).** Day-scale each.
22. **#773 — durable approvals + delegated authority.** What the next
    security review will ask about; prerequisite thinking for #810.
23. **#772 — run checkpoints & rewind.** The trust lever for autonomy.
24. **#774 — verifier pass for unattended runs.**

### Security spine — one per cycle, interleave with tiers above

- **#701 + #410 (enforce mode) — close the prompt-only write boundary.**
  Highest-value security item; gates #435 and #810.
- **#692 — OAuth disconnect route.** Small, compliance-visible.
- **#443 / #448 — run-lifecycle fencing + concurrency > 1.** Before scheduled
  load grows.
- **#449 — ops floor.** Alerting + immutable deploys.
- **#455, #457, #691, #697, #706** — remaining #453 Track A items, in the
  epic's own order.

### Human-gated / Rob-decision items (skip during unattended work)

- **#305 / #295 / #797 (models)** — enablement decisions are Rob's; #797
  (swappable brains epic) needs a scoping conversation before build.
- **#810 — actions-run-as-viewer** — decision ticket, not build work; blocked
  on #701/#410 anyway.
- **#697 — staging environment** — infra spend decision.

### Deliberately parked (do not start without a conscious call)

- **#736 Governed Custom Agents (+#745–#748)** — big new surface; start after
  Contribution Studio tracks close and #801 Tier C is underway, not before.
- **#491–#493 perimeter/identity/accountable-runtime epics** — enterprise
  gates; pull items only when an IT-review date makes them concrete.
- **#494 / #495 / #78** — habit loop, flywheel, share cards: wait for the
  team/org entity design and real usage signal.
- **#765 unified shell, #769 Button migration** — structural UI; after the
  Tier B polish lands and stabilizes.
- **#660 / #302 / #301** — model-substrate work rides behind #295 decisions.
- **#808 — in-thread artifact viewer-identity** — rides on J5 timing.

## Notes

- UI/UX epic #762 and harness epic #770 are tracking umbrellas; their
  actionable children are tiered individually above.
- #733 stays open as the alert thread; #782 is the fix ticket. Close both on
  three consecutive green nights.
- The August research record (sources for tiers C/D) lives in
  `docs/research/HARNESS_RESEARCH_2026-08.md`; viewer-identity decisions are
  on #801.
