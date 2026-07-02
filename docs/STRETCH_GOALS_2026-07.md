# Stretch Goals — The Wow-Factor Layer (July 2026)

Seven long-horizon bets that turn Comparative from a useful assistant into a
tool people evangelize and can't work without. Companion to
[`docs/BRAINSTORM_2026-07.md`](BRAINSTORM_2026-07.md) (the 90-day plan): the
90-day work is the *foundation*; these are what it's a foundation *for*.

**How to use this doc:** each goal is written to be scoped later without
re-having the conversation — what it is, the demo moment, the substrate that
already exists, a thin first slice vs. the full vision, dependencies, risks,
and the questions to answer at scoping time. None of these should be started
before the 90-day plan (#291–#305) is substantially landed and there are real
weekly users.

**Ordering** is by wow-per-feasibility, and the dependencies compound in
roughly this order too:

| # | Goal | One-liner | Demo moment |
|---|------|-----------|-------------|
| 1 | Approval Inbox | Safe write actions behind a single trust surface | "I cleared 40 minutes of work in 90 seconds" |
| 2 | Delegated Workstreams | Standing goals, not scheduled tasks | Something useful happens that nobody scheduled |
| 3 | Full Meeting Loop | Prep → transcript → decisions → tracked follow-through | "Here's what was promised last time, and its status" |
| 4 | Living Apps | Apps whose data refreshes itself | You open the app Tuesday and it's *current* |
| 5 | Multi-Agent Workrooms | Drafter + critic + gates, productized | Every important deliverable gets adversarial review |
| 6 | Org Brain | Curated org knowledge you can ask anything | A new hire's first week runs on it |
| 7 | Audit-Grade Replay | A "why" button on every answer | IT watches a full run replay and relaxes |

---

## 1. Approval Inbox — safe write actions

**One-liner.** Everything today is read-only. The approval inbox is the single
trust surface through which the assistant graduates to *doing* things: it
drafts actions (email replies, calendar holds, Notion updates, GitHub
comments, tickets), and the user approves, edits, or rejects each one — never
auto-executed.

**Demo moment.** Monday 8:05am: the inbox holds three drafted email replies, a
calendar hold for a conflict it spotted, and a drafted PR comment. Each shows
*why* it was drafted and exactly what will be sent. Four keystrokes later,
40 minutes of work is done. That sentence is the product pitch from then on.

**Why this is the biggest bet on the list.** Read-only assistants plateau at
"useful research tool." Write-with-approval assistants become load-bearing —
they occupy the execution seat, which is where switching costs live. And it's
the bet best matched to Comparative's existing moat: competitors hand-wave
writes; we have attestation, per-user credentials, audit, and an eval gauntlet
to make writes *defensible in an IT review*.

**Substrate already built.**
- Governance spine: `tools_catalog`, `user_tool_attestations`
  (`apps/web/lib/tool-attestations.ts`), `audit_log` — the same gate extends to
  write-scoped tools.
- Per-user OAuth (`oauth_tokens`, AES-GCM) — writes happen as the user, never
  as a service account.
- Notification center (#292) — the inbox is architecturally its sibling (or
  the same surface with an "actionable" item type).
- Runs ledger (`runs`, `run_events`) — a drafted action is a run output with a
  pending human step.
- Injection-resistance evals (#299) — the prerequisite discipline: content
  that *causes* a draft must never silently *become* an instruction.

**Architecture sketch (V1).**
- `proposed_actions` table: owner user, source run/trigger, provider + tool +
  full payload, human-readable summary + rationale ("drafted because…"),
  status (`proposed | approved | edited | rejected | executed | failed |
  expired`), expiry, audit linkage.
- Skills/workstreams emit proposed actions instead of calling write tools
  directly. The agent loop **cannot** execute a write-scoped tool — the only
  path to execution is a human approval transitioning the row, server-side.
- Inbox UI: batch review, inline edit of the payload (edit the email text,
  not JSON), one-keystroke approve/reject, "always reject this kind" →
  feedback into recommendations.
- Execution engine: on approval, execute with the owner's credentials, write
  audit rows, surface success/failure back into the inbox.
- Write-scope attestation: a second, explicit user attestation tier
  ("Comparative may *draft* sends for my approval") separate from read
  attestation; admin policy can cap which providers ever get write tools.

**Thin slice.** One provider, one action type: drafted Gmail replies
(pairs with #297's read integration — `gmail.compose` scope added but gated).
Scheduled "triage my inbox" run drafts replies to emails that look answerable;
user approves/edits/rejects from the notification center. No other providers
until the loop proves itself.

**Full vision.** Any connected provider's write surface flows through the same
inbox; workstreams (#2) and meeting follow-ups (#3) feed it; "auto-approve
this exact recurring action" exists but only after N manual approvals of
identical shape, is per-action-shape, revocable, and admin-visible.

**Dependencies.** #297 (Gmail read), #292 (notification center), #299 (evals);
write-safety review is its own human gate per provider (Rob).

**Risks / watch-outs.**
- Prompt injection is now consequential: a hostile email can try to get a
  draft sent to an attacker. Mitigations: drafts never auto-execute; the
  *recipient list* of any drafted communication is prominently surfaced;
  injection evals extended to draft-generation; rate caps on proposals.
- Draft quality below ~80% acceptance makes the inbox feel like homework —
  instrument acceptance rate per action type from day one and kill
  low-acceptance drafters.
- Legal/HR sensitivity: drafted external email is the riskiest category;
  consider internal-recipients-only for the pilot.

**Open questions for scoping.**
- Is the inbox a new surface or an item type inside the notification center?
  (Lean: same surface, distinct visual class.)
- Does an *edited* draft re-run any checks before send?
- Per-org policy model: which roles may approve which providers' writes?
- What's the audit story for an edit — store both drafted and sent versions?
  (Lean: yes, both, immutably.)

**Success signal.** Approved actions per user per week, and draft acceptance
rate ≥ 70% sustained. This is the direct extension of the north-star metric.

---

## 2. Delegated Workstreams — goals, not tasks

**One-liner.** Schedules run *tasks*; a workstream owns a *standing
objective*: "keep vendor renewals on track," "make sure nothing in my inbox
from a customer goes 24h unanswered," "watch our AWS spend." It monitors,
maintains state, drafts actions into the approval inbox, asks checkpoint
questions, and reports without being asked.

**Demo moment.** A notification you never scheduled: "Renewal for Acme lapses
in 21 days; last year's negotiation thread is attached; I've drafted the
kickoff email to their AE — approve?" Something useful happened *proactively
with context*. That's the moment the product stops feeling like a tool.

**Why us.** This is J3's logical conclusion, and the whole 90-day delivery
loop (#292/#293) is literally its nervous system. Nobody in the enterprise
space has shipped trustworthy long-horizon agents; the reason we can try is
the same as #1 — every action funnels through governance we already built.

**Substrate already built.**
- `runs` + `run_events` (durable, replayable, leased execution — see
  `docs/RUNS_DECISION.md`), `schedules` (cadence), `event_triggers` (#293).
- Vault memory + context pack (#187 work) — per-workstream memory is the same
  mechanism scoped to a workstream id.
- Notification center (#292) and approval inbox (#1) as the output channels.

**Architecture sketch (V1).**
- `workstreams` table: owner, objective (natural language), status, cadence +
  trigger subscriptions, linked skill(s), and a **workstream state document**
  (curated markdown, like Vault memory but workstream-scoped) the agent reads
  and rewrites each run — this is the long-horizon memory, inspectable and
  editable by the user.
- Each activation is an ordinary run: load objective + state doc + fresh tool
  data → decide (nothing to do | notify | propose action | ask a checkpoint
  question) → rewrite state doc → ledger.
- Checkpoint questions land as notifications with structured quick-replies;
  unanswered questions age into the digest.
- Weekly auto-status per workstream (reuses Weekly Status skill machinery,
  #298).
- Hard bounds: max activations/day, max proposals/day, budget cap per
  workstream; pause/kill switch on the workstream card.

**Thin slice.** One hand-built workstream template — "PR babysitter" (GitHub
is the strongest integration): objective = keep my open PRs moving; watches
webhook events (#293), nudges on staleness, drafts review-response comments
into the inbox. Proves objective + state doc + triggers + delivery without
open-ended objective parsing.

**Full vision.** Users create workstreams conversationally ("keep an eye on
X"); the assistant proposes the monitoring plan, cadence, and bounds for
approval; workstreams are shareable/transferable (vacation handoff);
recommendation engine suggests workstreams from observed repeated work — the
`recommendations` table already models this suggestion pattern.

**Dependencies.** #292/#293 (hard), #1 approval inbox for any action-taking
(a monitor-and-notify-only V1 works without it), per-workstream cost tracking
(cost fields exist on runs).

**Risks / watch-outs.**
- Long-horizon state drift: a stale/corrupt state doc quietly degrades every
  future run. Mitigations: user-visible/editable state doc, freshness stamps
  (the "owned-and-dated" principle from `docs/KNOWLEDGE_MANAGEMENT.md`), and
  a periodic self-audit run that verifies state claims against live data.
- Noise kills it faster than silence: over-notifying trains users to ignore
  it. Acceptance-rate instrumentation per workstream; auto-quiet on low
  engagement.
- Runaway cost: bounds are first-class schema, not afterthoughts.

**Open questions for scoping.**
- Is a workstream a special skill, or a new entity that *invokes* skills?
  (Lean: new entity invoking skills — skills stay stateless and shareable.)
- Multi-provider objectives (renewals need mail + calendar + maybe
  Salesforce): V1 single-provider or allow compositions?
- What does "done" look like — do workstreams complete, or only get paused?

**Success signal.** Active workstreams per user; proactive notifications acted
on (vs dismissed); at least one user story of a caught-before-it-burned event.

---

## 3. The Full Meeting Loop

**One-liner.** Meetings are the highest-volume artifact in knowledge work and
nobody closes the loop: **prep** before (already planned, #298) → **capture**
after (transcript ingestion) → **extraction** (decisions, action items,
owners) → **follow-through** (actions become workstream items / inbox drafts)
→ next meeting's prep includes "here's what was promised last time and its
status."

**Demo moment.** Walking into the Thursday recurring meeting: "Three action
items from last week: Dana's is done (PR merged Tuesday), yours is drafted and
waiting in your inbox, Sam's is untouched — want a nudge drafted?" Continuity
across meetings is something *no attendee* reliably provides today.

**Why us.** Meeting-notes tools (Otter, Fireflies, Copilot) stop at the
summary. The differentiator isn't transcription — it's that extracted
commitments land in an execution system (workstreams + inbox) wired to actual
work tools, under per-user data scoping an IT department will sign off on.

**Substrate already built.**
- Calendar read (#297) for the meeting graph; Meeting Prep skill (#298).
- File upload + text extraction (`apps/web/lib/attachments.ts`) — a transcript
  is just a document; V1 needs zero new ingestion tech.
- Artifacts for briefs/summaries; workstreams (#2) and inbox (#1) for the
  follow-through half.

**Architecture sketch (V1).**
- `meetings` entity keyed to calendar event id (recurring series aware):
  links prep brief, transcript artifact, extraction results.
- `commitments` table: meeting id, description, owner (attendee), due
  date, status (`open | done | dropped`), evidence link (the PR/email/doc
  that satisfied it), source quote from transcript.
- Extraction is a skill: transcript in → decisions + commitments out —
  transcript content nonce-framed as untrusted data (attendees' words must
  not become instructions; same discipline as #299).
- Status inference: for commitments matching connected-tool signals (a PR, an
  email sent), auto-suggest "done" with evidence; everything else asks the
  owner at next prep.
- Prep skill upgrade: prepend prior-meeting commitments + status to the brief
  for recurring series.

**Thin slice.** Manual transcript upload (user drops the .vtt/.txt from
Zoom/Meet — no API integration yet) → extraction skill → commitments shown in
next prep for that recurring series. Zero new integrations; proves the loop's
value before paying the transcript-API tax.

**Full vision.** Direct transcript pull (Zoom/Meet/Teams APIs — enterprise
phase, admin consent), auto-processing after each meeting, commitments feeding
workstreams, nudge drafts in the inbox, meeting-series health ("this recurring
meeting produced zero decisions in 6 weeks" — a genuinely spicy org insight).

**Dependencies.** #297/#298 (hard); #1/#2 for follow-through (extraction +
prep-continuity work without them); transcript APIs are enterprise-phase
(M365/Zoom admin consent — same gate as M365 mail).

**Risks / watch-outs.**
- Transcripts are the most sensitive text in the company (personnel, legal,
  strategy). Per-user scoping is non-negotiable: the uploader owns it; sharing
  is explicit; consider a no-retention mode (extract → discard raw).
- Attribution errors are embarrassing ("Sam promised X" when Sam didn't) —
  always show the source quote; commitments are *suggested*, confirmed by the
  user before they become tracked.
- Recording consent varies by org/jurisdiction — V1's manual upload neatly
  sidesteps this (the user already has the transcript legitimately).

**Open questions for scoping.**
- Are commitments per-user (my view of my meetings) or shared objects when
  both attendees are Comparative users? (Big fork: shared needs the team
  entity from #78's groundwork.)
- Does extraction run on the durable lane by default (transcripts are long)?
- Retention policy for raw transcripts vs. extractions?

**Success signal.** % of recurring meetings with prep-continuity active;
commitments confirmed per week; the qualitative one — someone says "the
meeting agent caught something we all forgot."

---

## 4. Living Apps — dashboards that feed themselves

**One-liner.** J4 apps today are deployed HTML snapshots. A living app has a
**data contract**: a scheduled run refreshes its data through the owner's
connected tools, so the app is a standing view over the connection layer —
"build me a pipeline tracker that updates every morning from Salesforce and
flags stalls."

**Demo moment.** A non-developer builds a tracker in conversation on Monday,
opens it Thursday, and it's *current* — without touching it. That's when
"I built software" becomes true for someone who has never deployed anything.

**Why us.** This is the J4 epic's (#133) natural V2 and the capability-funnel
thesis made vivid: conversation → app → *living organizational asset*. BI
tools do refreshing dashboards but need a data team; app builders (Retool
etc.) need a builder persona. Conversation-built + governance-wrapped +
self-refreshing is an empty quadrant.

**Substrate already built.**
- Apps + `app_versions` + edit sessions + stable URLs + CSP + secret-scan
  (#172–#175); schedules + runs; integrations via Gateway (#294).
- The artifact/app split already separates *shell* (HTML/JS) from content —
  the data contract formalizes it.

**Architecture sketch (V1).**
- App data contract: an app declares a `data.json` slot; the shell fetches it
  from a same-origin endpoint (`/apps/{slug}/data`) — CSP stays restrictive,
  no external calls from the app.
- `app_data_refreshes`: a schedule bound to the app, running a skill whose
  output artifact *is* the new data.json; versioned like app versions
  (rollback the data, not just the shell).
- **Viewer-vs-data credential rule (the hard design decision):** the refresh
  runs with the *owner's* credentials; viewers see what the owner's
  credentials produced. This is a deliberate, bounded exception to the
  "recipient credentials" share rule — safe only because the owner explicitly
  publishes a *fixed data shape* (like sharing a report), not live tool
  access. Must be prominent in the share flow UI ("viewers will see data
  fetched as you") and in the audit trail. Admin policy can disable
  owner-credentialed data apps org-wide.
- Staleness surfaced in the app chrome: "data as of 7:02am today; refresh
  failed 2 days ago" — never silently stale (the honesty spine applies to
  apps too).

**Thin slice.** GitHub-backed team dashboard (open PRs, stale reviews, CI
health) as a starter app template with a daily refresh — GitHub credentials +
an audience of engineers who forgive rough edges, and it dogfoods the whole
contract.

**Full vision.** Any-provider data skills; refresh-on-demand button; alert
thresholds in the data contract ("if any value crosses X, notify the owner"
— which quietly turns living apps into visual workstreams); app templates in
the share/discovery layer (#78) so one person's tracker becomes the org's.

**Dependencies.** #133 V1 (shipped), the app iterate loop (J4 phase 2 —
sequence this after it), #294 integrations, schedules (shipped). The
artifact-revision consolidation flagged in the brainstorm is a *hard*
prerequisite — this stacks more semantics on that fragile surface.

**Risks / watch-outs.**
- The owner-credential exception is the security-review flashpoint: scope it
  tightly (fixed data shape, no viewer-triggered fetches, explicit consent
  language, auditable) or IT will kill the whole feature.
- Data in Postgres text columns won't survive many apps × daily refreshes ×
  version history — the S3 artifact move graduates from "eventually" to
  prerequisite.
- Refresh failures must page the owner (via #292), not rot silently.

**Open questions for scoping.**
- Data versioning retention (keep N refreshes? all?).
- Can editors (app roles from #175) modify the data skill, or owner-only?
- Size cap per data.json; what happens at the cap?

**Success signal.** Apps with active refresh contracts; viewer opens per week
per living app (a living app should be *visited*, unlike static ones).

---

## 5. Multi-Agent Workrooms — productize our own pipeline

**One-liner.** The meta-insight: this repo is *already built* by a multi-agent
organization — Codex implements, Claude adversarially reviews, deterministic
gates enforce, Rob owns judgment. That pattern (worker + critic + gates +
human owner) is the actual secret, and it generalizes to knowledge work: a
workroom where a drafter agent produces the deliverable and a critic agent
challenges it against the data before the human ever sees it.

**Demo moment.** Ask for a quarterly business review. Watch the workroom: the
drafter produces v1; the critic flags "slide 3's growth claim contradicts the
Databricks number, and the churn narrative ignores the two accounts lost in
May"; v2 addresses it, with the challenge log attached. The human gets a
deliverable that *already survived review* — with receipts.

**Why us.** "Every important deliverable gets adversarial review" is a quality
story no assistant vendor tells, and we have months of lived proof from our
own dev pipeline (`docs/AI_PR_REVIEW_PIPELINE.md`) that it works — including
the failure modes and the gate design. This is also the natural home for the
model-substitution thesis: drafter and critic *should* be different models
(#295's registry makes that a config choice), because diverse critics catch
what redundant ones can't.

**Substrate already built.**
- The pipeline itself as the design reference (roles, markers, verdicts,
  same-branch iteration, human-owned merge).
- `runs`/`run_events` for multi-step execution with replayable history;
  artifacts for draft versions (versioning exists); skills as role
  definitions (a critic is a skill with a rubric-shaped system prompt —
  CLAUDE.md is literally a worked example of a critic rubric).
- Model registry + qualification (#295) for per-role model choice.

**Architecture sketch (V1).**
- A workroom is a structured run: `workroom_sessions` (deliverable goal,
  linked thread, status) + role slots (drafter skill, critic skill(s),
  optional researcher) + a bounded loop: draft → critique → revise, max N
  rounds, converge or escalate to the human.
- Critique is structured (finding, severity, evidence citation), rendered as
  a challenge log artifact beside the deliverable — the receipts are the
  product as much as the deliverable.
- Critic rubrics are user/org-editable skills: "our QBR standard," "our legal
  tone check" — this is where org standards become executable (feeds #6).
- Runs on the durable lane (it's long); progress streams to the thread via
  run events like other worker runs.

**Thin slice.** One built-in workroom: **Document Review** — user provides a
draft (theirs or the assistant's) + picks a critic rubric (starter rubrics:
factual-consistency-against-attachments, executive-clarity, data-integrity);
one critique round with challenge log. Single-role, immediately useful, no
orchestration complexity.

**Full vision.** Named recurring workrooms per deliverable type; multi-critic
panels with different models/lenses; workroom templates shareable (#78);
scheduled workrooms ("QBR workroom runs on the 1st, human gets v2 + challenge
log") — composing #2, #4, and this into the same substrate.

**Dependencies.** #295 (for multi-model roles; single-model works first),
durable lane maturity (AgentCore migration helps), artifact versioning
(shipped). Genuinely independent of #1–#4 — could be sequenced early if a
flagship "quality" story is wanted sooner.

**Risks / watch-outs.**
- Cost multiplies per round × critic — bounded rounds, per-workroom budget,
  cost display up front.
- Critic theater: a critic that rubber-stamps or nitpicks style is worse than
  none. Critic skills need their own evals (does it catch planted errors?) —
  extend the gauntlet with seeded-defect fixtures, exactly like the eval
  lessons in `docs/REGRESSION_GAUNTLET.md`.
- Latency expectations: this is minutes, not seconds — set that expectation
  in UX (it's a worker run with progress, not a chat reply).

**Open questions for scoping.**
- Does the human see intermediate drafts live, or only the converged result +
  log? (Lean: converged + log by default, live view available.)
- Are critiques advisory or can a critic *block* (needs-work state) like
  needs-codex does in the dev pipeline?
- Where does the drafter's context come from — thread, project (#6's
  groundwork), or explicit attachments only?

**Success signal.** Deliverables run through workrooms per week; planted-error
catch rate in critic evals; users choosing workroom mode for high-stakes docs
unprompted.

---

## 6. The Org Brain

**One-liner.** Approved memories, share cards, skill runs, meeting decisions,
and project context accrete into **curated org knowledge** — "ask the company
anything": who worked on this, how do we usually handle that, what did we
decide in March and why. The compounding asset that makes year-two Comparative
irreplaceable.

**Demo moment.** A new hire's first week: "What should I know about the Acme
account?" → grounded answer citing the account brief, the March pricing
decision (with the meeting it came from), and who owns the relationship —
each with source, owner, and freshness date. Onboarding that used to take
three coffee chats and a wiki archaeology dig.

**Why us.** Everyone pitches "chat with your company docs" via RAG over a
crawled corpus — and it fails IT review (shadow index, stale wiki at scale,
leakage) and quality review (garbage in). Our ADR-0001 position —
**curated-not-crawled, owned-and-dated, cheapest-sufficient-mechanism** — is
the defensible architecture, and the funnel (chats → skills → meetings →
workstreams) *generates* curation candidates as a byproduct of work, which is
the part nobody else has: the org brain is fed by usage, not by a crawler.

**Substrate already built.**
- Four-scope context design (user → project → team → org) in
  `docs/KNOWLEDGE_MANAGEMENT.md` + ADR-0001; single injection point
  (`buildAgentPreamble`).
- Vault memory capture → approve → inject loop (`memory-capture.ts`,
  `user_memory_items`) — the org brain is the same lifecycle at wider scopes
  with heavier governance.
- Share cards (#78) as the social/discovery precursor; audit + provenance
  for the trust layer; meeting decisions (#3) and workroom rubrics (#5) as
  high-value feeder streams.

**Architecture sketch (V1 — deliberately boring).**
- `org_knowledge_items`: scope (team/org), kind (decision | practice | fact |
  glossary | ownership), content (markdown), **owner (a person, required)**,
  source link (thread/meeting/run), freshness date, review-by date, status
  (proposed | approved | stale | retired).
- Feeder: the memory-capture reviewer, at org scope — after meetings,
  workroom runs, notable threads, it *proposes* items; a designated curator
  (owner/admin role) approves. Nothing enters the brain without a human
  owner attached.
- Injection: org items join the context pack scoped by relevance (start with
  explicit tags + capability-graph matching — **no vector DB until context
  budget forces it**, per ADR-0001; pgvector-in-RDS is the designated
  escape hatch, not the starting point).
- Staleness is enforced, not aspirational: items past review-by date stop
  injecting and nag their owner — this is the anti-stale-wiki mechanism and
  the honesty spine applied to knowledge ("I have a possibly-outdated note
  from March" beats asserting it fresh).

**Thin slice.** Team glossary + decisions log, fed *only* from meeting
extractions (#3) and manual "remember this for the team" — one curator, one
team, explicit tags. Prove that curation-as-byproduct produces items people
actually rely on before widening the feeders.

**Full vision.** Org-wide scopes with role-based visibility; "who knows
about X" (expertise inferred from *approved, visible* work only — never from
private chats); onboarding packs per role; decision provenance chains ("this
practice superseded that one, here's why"); the discovery feed (#78) and the
brain converging into one knowledge surface.

**Dependencies.** Team/org entity (the #78 groundwork) is a hard prerequisite;
#3 meeting extraction is the best feeder; curator role in the permission
model. This is deliberately *last* in build order: it needs a year of real
usage to be worth anything — but the schema decisions (owner, source,
freshness as required fields) must be right from the first item.

**Risks / watch-outs.**
- Leakage is the catastrophic failure: a private-chat fact surfacing
  org-wide ends the product's trust story. Items carry their visibility at
  creation; feeders can only propose *upward* with explicit human approval at
  the wider scope; eval coverage for scope honesty.
- Stale-wiki death is the slow failure: the review-by mechanism is the whole
  bet — if scoping ever cuts it, cut the feature instead.
- Curation burden: if the curator queue feels like homework, feeders are too
  chatty. Quality bar over quantity; measure approval rate.

**Open questions for scoping.**
- Who curates — admins, per-team owners, or item-kind-specific owners?
- Do org items inject silently or as visible receipts ("using org note:
  Acme pricing decision, owner Dana, March 2026")? (Lean: visible — it
  markets the brain while grounding the answer.)
- Retention/deletion: when an employee leaves, what happens to items they
  own?

**Success signal.** Items relied on (injected into a turn the user rated
useful) per week; item freshness compliance; the new-hire story happening
unscripted.

---

## 7. Audit-Grade Replay — "show your work"

**One-liner.** Every answer gets a *why* button: the tools called (with
scopes), the context injected (which memories, which org items, which files),
the model that served it, and the routing decisions — as a human-readable
receipt. Admins get full run replay.

**Demo moment.** Two audiences. IT/security: watch a complete run replay —
every tool call, every credential scope, every injected context item — and
visibly relax; that meeting is where enterprise deals are won. Users: click
"why did you say that?" and get a real answer, which is also the moment they
start *trusting* answers they don't check.

**Why us.** It's the trust feature that makes #1, #2, and #6 shippable at all
— write actions, autonomous workstreams, and org knowledge all need "we can
show exactly what happened" as their safety case. And it's mostly *exposure*
of what already exists rather than new machinery: the product already records
nearly everything; it just doesn't show it.

**Substrate already built.**
- `run_events` is append-only and replayable *by design* (that's the point of
  `docs/RUNS_DECISION.md`); `audit_log` with nullable FKs for
  retention-surviving compliance; tool audit rows per call; model provenance
  (#243, extended by #303); context receipts designed in the Context Engine
  epic (#187); the admin run inspector exists as a seed.

**Architecture sketch (V1).**
- Receipt renderer: for any assistant message, compose from existing data —
  context items injected (from context-pack receipts), tools called with
  provider + scope + duration (from audit/tool events), serving model + lane
  (provenance), files/artifacts referenced. Human-readable, not JSON.
- User-facing "why" affordance on messages in tool-using/durable threads
  (collapsed by default; don't clutter fast-lane chat).
- Admin replay view: step through a run's events with payload previews,
  **redaction-aware** (payloads may contain the user's tool data — replay
  access is itself scoped and audited: admins see structure and metadata by
  default, content access requires a logged justification).
- Gap-fill audit: one pass to find anything injected into a turn that isn't
  yet receipt-tracked (the #180 upload bug class — content used but not
  recorded) and close those gaps. The receipt is only as trustworthy as its
  completeness.

**Thin slice.** User-facing receipts on tool-lane messages only (tools +
model + injected memories). The admin replay view second. The IT-facing
export ("give me everything about run X as a document") third.

**Full vision.** Org-level trust reporting (what % of answers were grounded
in tools vs. model-only — a genuinely novel enterprise metric); receipts as
the substrate for #5's challenge logs and #6's knowledge provenance; retention
policies with legal-hold awareness.

**Dependencies.** None hard — this is the most start-anytime item on the
list, and the best cheap complement to the enterprise-gate track. Receipts
get richer as #295/#303 (provenance) and #187's context receipts mature.

**Risks / watch-outs.**
- Watching the watchers: replay itself is a data-access surface — it must be
  scoped and audited or it *creates* the cross-user exposure it exists to
  prevent.
- Receipt honesty: an incomplete receipt is worse than none (it asserts
  completeness it doesn't have). The gap-fill audit is a prerequisite, and
  receipts should state their own coverage ("this receipt covers tools,
  context, and model; it does not cover X").
- Don't over-engineer the user surface: a paragraph beats a trace viewer for
  the "why" button.

**Open questions for scoping.**
- Retention of full event payloads vs. receipt summaries (cost/privacy
  tradeoff)?
- Are receipts immutable snapshots at answer time, or rendered live from the
  ledger? (Lean: immutable snapshot — the receipt must describe what
  *happened*, even if data is later deleted; align with the audit-log
  nullable-FK retention pattern.)
- Do shared artifacts/apps carry their provenance receipt with them?

**Success signal.** "Why" clicks that end without a follow-up complaint; the
IT review meeting where replay is shown and the objection list gets shorter;
zero incidents where a receipt claimed something that didn't happen.

---

## How these compose

The seven aren't a menu of equals — they're one system seen from seven sides:

- **#292/#293 (delivery + triggers)** is the nervous system → **workstreams
  (#2)** are its brain → the **approval inbox (#1)** is its hands.
- **Gmail/Calendar (#297)** feeds the **meeting loop (#3)**, whose
  commitments feed **workstreams (#2)** and the **inbox (#1)**.
- **J4 + schedules** become **living apps (#4)**; alert thresholds make
  living apps visual workstreams.
- The **model registry (#295)** makes **workroom (#5)** roles
  model-diverse; workroom rubrics and meeting decisions feed the
  **org brain (#6)**.
- **Replay (#7)** is the trust floor under all of it — and the cheapest to
  start.

Suggested sequencing conversation when the time comes: **#7 early** (cheap,
compounds trust), **#1 + #2 as the flagship pair** (they're the product's
identity shift), **#3 next** (rides the Gmail wave), **#4 after J4 phase 2 and
the artifact consolidation**, **#5 when a quality flagship is wanted**, **#6
only once teams exist and usage is real**.

Every one of these inherits the non-negotiables: per-user data scoping, no
credential escalation, untrusted content framed as data, capability honesty,
and the bug → regression rule. If a scoped version of any of them can't
satisfy those, the scoped version is wrong, not the rules.
