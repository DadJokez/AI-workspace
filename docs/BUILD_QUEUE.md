# Build Queue — re-triaged 2026-07-07 (post-merge)

Prioritized, dependency-ordered queue of open work. Previous triage 2026-07-06;
re-triaged after the 2026-07-07 merge session landed all of Tier A plus web
search (#292, #304, #299, #300, #313 → PRs #314–#318) and the housekeeping
decisions below.

**Consumed by `/goal`** (`.claude/commands/goal.md`): an overnight session works
this queue top-down, skipping anything whose dependencies aren't merged to
`main` or that is human-gated. Re-triage when this file is more than ~2 weeks
old or the queue is empty.

## Triage summary

| Issue | Title (short) | Verdict | Blocked by |
|---|---|---|---|
| #297 | Gmail + Calendar Gateway integration | **Ready** | — (credential gate cleared; see notes) |
| #301 | Model qualification pipeline | **Ready** | — (#300 merged) |
| #293 | GitHub webhook event triggers | **Ready** | — (#292 merged) |
| #303 | Router model selection in lanes | **Ready** | — (#300 merged) |
| #321 | Artifact revision consolidation (was G2) | **Ready** | — (hard prereq for #322) |
| #302 | Admin model page | Ready after dep | #301 merged |
| #298 | Meeting Prep + Weekly Status skills | Ready after dep | #297 merged |
| #322 | J4 phase 2: conversational iterate loop (was G3) | Ready after dep | #321 merged |
| #305 | Enable first non-Anthropic models | Rob-gated | #301–#303 + Rob's enablement click |
| #291 | SES production invite email | **Rob-gated (ops)** | e2e proof: send + confirm a real invite (PR #272 closed as superseded by #312) |
| #295 | [EPIC] Model qualification | Tracking only | children #300 done; #301–#305 above |
| #294 | [EPIC] Integration factory | Tracking only | children #299 done; #297–#298 above |
| #27 | [EPIC] Scheduled agents | Housekeeping | close when #293 lands (decision recorded on the issue) |
| #78 | Shared AI work cards | Deferred | team/org entity doesn't exist — see G4 |

Closed since last triage: #133 (verified V1-complete against main; phase 2
filed as #322), #292/#299/#300/#304/#313 (shipped), PR #272 (superseded).

## Prioritized queue

### Tier A — start tonight (unblocked, locally verifiable)

1. **#297 — Gmail + Calendar integration.** The pilot flagship, now fully
   unblocked: OAuth connect flow shipped (#311), credentials provisioned and
   deployed (verified in the production secret 2026-07-07), evals merged
   (#299). Remaining scope: the Gateway/MCP execution target (+ OpenAPI spec),
   catalog/audit/attestation wiring on execution, nonce-framing of message and
   event bodies (including the mutation-check eval deferred from #316),
   **token refresh** (refresh tokens are stored but never exchanged — grants
   go stale in ~1h), expired-grant reconnect UX, and live e2e verification.
2. **#301 — Model qualification pipeline.** Unblocked by #300. Runs the eval
   gauntlet against a candidate model, persists a scorecard. Unlocks #302,
   feeds #305.
3. **#293 — Event triggers (GitHub webhooks).** Unblocked by #292. Closing it
   also closes epic #27 (decision recorded there).
4. **#303 — Router model selection within lanes.** Unblocked by #300; #302
   surfaces its events but is not a dependency.
5. **#321 — Artifact revision consolidation.** Refactor-with-characterization-
   tests; hard prerequisite for #322. Mandatory before J4 phase 2 or Projects
   stack more semantics on the revision surface.

### Tier B — unblocks as Tier A merges

6. **#302 — Admin model page** — after #301.
7. **#298 — Meeting Prep + Weekly Status skills** — after #297.
8. **#322 — J4 phase 2 conversational iterate loop** — after #321.

### Tier C — Rob-gated, not overnight work

- **GCP OAuth consent screen** — check publish status (Testing vs published)
  and the test-user list. Testing mode = 7-day refresh expiry + 100-user cap,
  which changes #297's reconnect design. Blocks nothing tonight, but decide
  before #297's live verification.
- **#291 (SES)** — production access is live and deployed (#312); what
  remains is end-to-end proof: send a production invite, confirm receipt,
  then close. **`/goal` must not touch this.**
- **#305** — final qualification + enablement run; enablement click is Rob's,
  after #301–#303.

### Housekeeping

- **#27**: close when #293 lands (Rob's decision, recorded on the issue
  2026-07-07).
- **#295 / #294**: keep open as tracking epics; no direct work.

---

## Grooming specs — unfiled or under-specified work

G1 (web search) shipped as #313 (PR #318). G2 filed as #321. G3 filed as
#322. Remaining:

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
