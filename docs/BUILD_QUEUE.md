# Build Queue — re-triaged 2026-07-10

Prioritized, dependency-ordered queue of open work. Re-triaged after the
AgentCore deployment fixes and the overnight product tranche landed.

**Consumed by `/goal`** (`.claude/commands/goal.md`): an overnight session works
this queue top-down, skipping anything whose dependencies aren't merged to
`main` or that is human-gated. Re-triage when this file is more than ~2 weeks
old or the queue is empty.

## Completed in this tranche

- AgentCore deployment hardening landed in PRs #335 and #339; production now
  builds the runtime on native ARM and deploys it through the normal pipeline.
- Gmail + Calendar execution (#297) is implemented. Calendar read was proven
  live; final Gmail acceptance is human-gated because the Gmail API is disabled
  in Google Cloud project `327348890968`.
- Meeting Prep + Weekly Status skills (#298), artifact revision consolidation
  (#321), conversational app iteration (#322), and GitHub event triggers (#293)
  shipped to `main`.
- Chat completion notifications (#331), durable drafts (#333), raw Markdown
  copy (#334), and edit-and-resend (#332) shipped to `main`.
- Scheduled-agents epic #27 is closed.

## Triage summary

| Issue | Title (short) | Verdict | Blocked by |
|---|---|---|---|
| #344 | Reconcile conversational app drafts after reload | **Ready — P0 bug** | — |
| #330 | Per-turn token and cost meter | **Ready** | — |
| #301 | Model qualification pipeline | **Ready** | — (#300 merged) |
| #303 | Router model selection in lanes | **Ready** | — (#300 merged) |
| #349 | Suppress legacy orphaned run receipts | **Ready** | — |
| #348 | Edit-and-resend for uploaded-file prompts | **Ready** | — |
| #302 | Admin model page | Ready after dependency | #301 merged |
| #305 | Enable first non-Anthropic models | Rob-gated | #301–#303 + Rob's enablement click |
| #297 | Gmail + Calendar Gateway integration | **Human-gated acceptance** | enable Gmail API, then live Gmail/draft and Calendar write smoke |
| #291 | SES production invite email | **Human-gated acceptance** | send and confirm a real production invite |
| #295 | Model qualification epic | Tracking only | children #301–#305 |
| #294 | Integration factory epic | Tracking only | close after #297 live acceptance |
| #78 | Shared AI work cards | Deferred | team/org entity does not exist — see G4 |

## Prioritized queue

### Tier A — unblocked and locally verifiable

1. **#344 — app-draft reload hardening.** Fix the correctness regression before
   adding more app-building behavior. Reconcile historical cards against the
   live app version and structurally block draft creation when oversized source
   content was omitted.
2. **#330 — per-turn token and cost meter.** Surface usage already persisted by
   the runtime in the chat receipt; no new provider or infrastructure needed.
3. **#301 — model qualification pipeline.** Run the eval gauntlet against a
   candidate model and persist a versioned scorecard. This unlocks #302 and
   supplies the evidence required by #305.
4. **#303 — router model selection within lanes.** Select among enabled,
   qualified models by task class, policy, and availability while preserving
   truthful provenance.
5. **#349 — legacy receipt suppression.** Close the small edit-history edge
   case identified during PR #347 review.
6. **#348 — edit uploaded-file turns.** Extend edit-and-resend only after file
   payload replay is explicit and test-covered.

### Tier B — dependency ordered

7. **#302 — admin model page** — after #301.
8. **#305 — qualify and enable non-Anthropic models** — after #301–#303 and
   Rob's explicit enablement decision.

### Tier C — human-gated acceptance, skip during unattended work

- **#297 (Google)** — open the Gmail API page for project `327348890968`,
  enable the API, then prove Gmail search/read + native draft creation and the
  Calendar proposal/confirmation/idempotency flow. Calendar read is already
  live-proven. Do not rebuild the integration while this external gate remains.
- **#291 (SES)** — send a production invite to a real inbox and confirm receipt.
- **#305** — the final model enablement decision remains Rob's even after the
  qualification and routing code is ready.

### Housekeeping

- Keep #295 open until #301–#305 are resolved.
- Keep #294 open until #297 passes live acceptance; #298 is complete.

---

## Grooming specs — unfiled or under-specified work

G1 (web search), G2 (artifact revision consolidation), and G3 (conversational
app iteration) are shipped. Remaining:

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
