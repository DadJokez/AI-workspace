# Memory & Context Architecture for Comparative (AI Hub)

**Status:** Research spec — no implementation. Produced 2026-07-12 via deep research (24 sources fetched, 115 claims extracted, 25 top claims adversarially verified: 14 confirmed 3–0, 0 refuted, 11 unverified-by-vote but quoted from primary vendor docs — see [Verification notes](#verification-notes)).

**Grounding:** `TECHNICAL_OVERVIEW.md` (July 2026 snapshot) and the research prompt `01-memory-context-research-prompt.md`.

---

## 1. Executive summary

Comparative already made the single most important memory decision correctly, apparently by accident: **Vault memory is approval-gated** — captured windows become *proposed* items, and only *approved* items feed the Personal Context block. That is the consumer-memory model (Claude.ai's), not the developer-tool model (Claude Code's), and it is the right template for the org's non-technical users. This spec's core recommendations:

1. **Four memory scopes**, generalized from the existing `user_memory_items` machinery: **per-tool** (a Skill/App's own accumulated notes), **per-user** (today's Vault), **per-team** (group-visible promoted knowledge), **org-wide** (org conventions, admin-curated). One table, one scope enum, one permission check — not four systems.
2. **One identity/group substrate.** Team-scoped memory must use the *same* group model that connector governance (prompt #3) uses — PingOne/PingFederate OIDC group claims as the automatic backbone, plus self-formed teams layered on top. Two parallel permission systems will drift; the research found no system that benefits from separating "who can reach this tool" from "who can see this memory."
3. **Promotion is explicit and reviewed, never automatic.** Default-private with human-gated promotion is the strongest cross-source consensus in the research (MindStudio, the governed-memory paper, Anthropic's own consumer design). AI-authored notes that skip review measurably persist falsehoods and *reduce* task success (ETH Zurich, Feb 2026: LLM-generated context files −3% success, +20% cost; human-written +4%).
4. **Departure = non-retention, not export.** Personal memory is purged after deprovisioning (SCIM/Ping-triggered, with a grace window); anything already promoted to team/org stays, with authorship preserved for audit. "Leaves with them" as literal export is a policy Comparative must **not** assume — the org almost certainly treats everything produced on company systems as company property. This needs Legal/HR sign-off; flagged plainly in §5.
5. **Compaction: build it shell-side now; adopt the server-side `compact_20260112` API primitive later.** The blocker is concrete: Comparative's fast lane runs on Bedrock `converseStream`, and per AWS docs the compaction beta is **not supported by the Converse API** (InvokeModel only, and only on a subset of models). The shell already owns context assembly (`buildTurnContext`) and has a pending rolling-thread-summary feature — finish that as the compaction equivalent, with **constraint pinning**: org/team memory and governance rules are re-injected after every summarization, never summarized. A June 2026 study shows why this is non-negotiable: compaction raises policy-violation rates from 0% to a pooled 30% when constraints get summarized away, and pinning restores 0% for ~47 tokens.
6. **Checkpoints are version control, not memory — and Comparative needs them as a first-class capability regardless.** J4's `app_versions` + plain-language revert is already the right shape. Extend the same pattern to Skills; keep it decoupled from conversation history (the Claude Code rewind menu's separation of "restore code" vs. "restore conversation" is the model).

---

## 2. The layer stack found in research

### 2.1 How harnesses answer "what do I already know?"

Every mature harness stacks **three distinct kinds of persistence** — and the ones that blur them are the ones with documented failure modes:

- **User-authored rules** (CLAUDE.md, Cursor rules, AGENTS.md, Copilot instructions): deliberate, versioned, shareable. Human-written rules measurably help (+4% task success; a Princeton study of Codex across 124 merged PRs found repo AGENTS.md files cut median runtime 28.6% and tokens 16.6%).
- **AI-authored notes** (Claude Code auto memory, Claude.ai memory synthesis, ChatGPT saved memories, Cloudflare Agent Memory): accumulated automatically, needs curation. Ungoverned, it persists plausible falsehoods — a documented multi-agent ecosystem accumulated three false auto-memory entries that survived as reloadable state until a human audit (arXiv 2605.04264).
- **Conversation summaries** (client `/compact`, server-side `compact_20260112`, rolling thread summaries): *ephemeral session continuity*, not knowledge. The default compaction prompt is explicit that the summary exists so work can continue "in a future context where the raw history … will be replaced."

The three-way distinction is explicit in Claude Code and the Claude API (three separate primitives). It is blurred in ChatGPT (saved memories + chat-history retrieval fold together, person-scoped, "not suitable for direct sharing") and in Gemini (memory is derived from the Google-account ecosystem rather than authored at all). A useful one-liner from the May 2026 comparison literature: **ChatGPT models the person, Claude Code models the project, Gemini models the ecosystem.** Comparative must model all four: the person, the tool, the team, and the org.

### 2.2 Comparison table

| Mechanism | Who authors it | What triggers it | What survives what | Notes / limits |
|---|---|---|---|---|
| **CLAUDE.md hierarchy** (managed-policy → user `~/.claude/` → project → `CLAUDE.local.md`) | User / org admins | Loaded at session start; all discovered files **concatenated**, not overriding | Project-root CLAUDE.md **survives `/compact`** (re-read from disk, re-injected) | Loaded in full regardless of length; ~200-line guidance; managed-policy files cannot be excluded by individuals; **guidance only, not enforcement** — hard guarantees need settings/hooks |
| **Nested/subdir CLAUDE.md** | User | Lazy-loaded when Claude reads a file in that subtree | **Does NOT survive `/compact` automatically** — reloads only on next matching file read | Confirmed still-current (July 2026). This asymmetry is the classic "why did it forget mid-task" report — the prompt's claim verified 3–0 |
| **Auto memory (`MEMORY.md` + topic files)** | The AI | Written from corrections/preferences during sessions; loaded at session start | Hard load budget: first **200 lines or 25KB** of MEMORY.md only; topic files read on demand | Scoped **per git repo, machine-local**, no cloud sync; subagents can keep separate auto memory; on by default (v2.1.59+) |
| **Session memory / rolling summary** | The AI (background) | Written during session; `/compact` can load it instead of re-summarizing | Session-scoped; transcripts auto-deleted after 30 days (`cleanupPeriodDays`) | Time-bounded raw history, not durable knowledge |
| **Client-side compaction (`/compact`, targeted "Summarize from/up to here")** | The AI, user-triggered or auto near limit | Context approaching limit | Summary replaces messages in active context; originals preserved in transcript | A UX feature of one harness — not portable |
| **Server-side compaction (`compact_20260112`)** | The API | `input_tokens` trigger, default 150K, floor 50K (only trigger type) | Emits a `compaction` block; API **drops all blocks before it** on subsequent requests | Beta header `compact-2026-01-12`; custom `instructions` **replace** (not supplement) the default prompt; `pause_after_compaction` lets the client re-inject content; billed via `usage.iterations` (hidden from top-level counts); causes prompt-cache miss; **on Bedrock: InvokeModel only, NOT Converse** (per AWS docs — verify currency) |
| **Context editing (`clear_tool_uses_20250919`)** | The API | Default 100K input tokens | Oldest tool results cleared (placeholder left), newest 3 kept | Server-side, client history untouched; invalidates prompt cache at the cut; warns the model first so it can save to memory |
| **API Memory Tool (`memory_20250818`)** | The AI, executed by the harness | Auto-injected system prompt: "always view your memory directory before doing anything else" | Cross-session; survives compaction by design ("memory preserves what must survive summarization") | **Client-side primitive: the harness owns storage, scoping, security** (path-traversal validation, size caps, sensitive-data stripping, expiry). GA, no beta header, Claude 4+. This is Comparative's most directly relevant building block |
| **Checkpoints / rewind** | The harness, automatic | Every user prompt; before each file edit | Persist across sessions; cleaned after 30 days (configurable) | **Not memory** — "local undo" vs. Git as "permanent history." Rewind decouples restore-code / restore-conversation / both. Gaps: bash-modified files and external edits untracked |
| **Claude.ai consumer memory** | The AI, user-editable | Background synthesis (~24h cycle) of chat history | Cross-session, **per-project scoped** (separate memory space per project); deleted convos purged from synthesis within 24h | Relevance-filtered toward work context; single visible/editable memory summary; pause/reset; incognito chats never enter memory; **Enterprise admin disable = immediate deletion of all users' synthesis**; exportable per-project. Launched Team/Enterprise Sept 11 2025, Pro/Max Oct 23 2025 |
| **Cursor rules** (`.cursor/rules/*.mdc`) | User | Four activation modes: always / glob auto-attach / agent-decided / manual `@rule` | Per-request attachment | Legacy `.cursorrules` deprecated; `.cursorignore` for exclusions |
| **AGENTS.md / Codex** | User | Merged top-down (`~/.codex/AGENTS.md` → repo root → cwd); nearest-file-wins in monorepos | Per-session load | Linux Foundation standard, 60K+ repos, 20+ tools; Codex enforces **32 KiB cap with silent truncation**; OpenAI's monorepo has 88 of them |
| **Copilot instructions** | User | Repo-wide file sent with every message; path-scoped files via `applyTo` frontmatter | Per-request | |
| **Skills (SKILL.md)** | User | Progressive disclosure: frontmatter always, body on task match, resources on demand | N/A | The context-budget-respecting pattern Comparative's Skills should copy |

### 2.3 The findings that should shape Comparative's design

**Compaction is a governance hazard, not just a UX feature.** A June 2026 study (arXiv 2606.22528, 1,323 episodes, 7 models): compaction raises safety-policy violations from 0% to a pooled 30% (up to 59%). The mechanism is entirely about *layer placement* — if the constraint survives the summary, violations stay at 0%; if dropped, 38%. Decay by layer: policy in the **preserved system message +0 points**; as a standing user instruction **+50**; as a memory entry **+45**; as tool output **+33**. Soft org-specific policies (exactly what Comparative injects) decay 8.3× worse than hard safety norms (+50 vs +6) — model safety training does not protect *your* rules. Mitigation: **Constraint Pinning** — a buffer exempt from compaction, re-injected verbatim after every compaction step — restores 0% at ~47 tokens. The summarizer is also an injection target: searched injection strategies against the compaction step raised one model's violation rate from 0% to 65%. Comparative's existing prompt-injection framing posture must extend to whatever performs summarization.

**AI-authored context is worse than none unless curated.** ETH Zurich (arXiv 2602.11988, Feb 2026): LLM-generated context files *reduced* task success ~3% vs. no context while raising inference cost 20%+; human-written files improved success ~4%. Combined with the false-memory-persistence case above, this kills any "silently auto-learn and auto-inject" design. Comparative's approval gate is not friction to remove — it is the quality mechanism.

**The layer-selection framework, distilled.** Anthropic's cookbook and docs converge on: **clearing** for re-fetchable tool-result bloat; **compaction** for dialogue growth *within* a session; **memory** for anything that must cross sessions; **enforced settings/gates** (not prompt text) for anything that must be guaranteed. Claude Code's own docs draw the enforcement boundary explicitly: CLAUDE.md and memory shape behavior but are *unenforced*; hard rules live in client-enforced mechanisms. For Comparative this maps to: knowledge → memory scopes; policy the model should follow → pinned org context; policy the model must not be able to break → the tool gate / attestations / catalog, which already exist.

**Large context windows do not retire memory.** 1M-token windows are now the default on current Claude models (no beta header, standard pricing). Anthropic's own docs still warn of **context rot** — "as token count grows, accuracy and recall degrade … curating what's in context is just as important as how much space is available." Lost-in-the-middle (Liu et al., Stanford 2023) quantifies it: 15–20-point accuracy drop purely from position. **Position taken:** the window size debate is about *when compaction fires*, not *whether memory exists*. Capacity solves transcript length; it does nothing for relevance (which 3 facts of 10,000 matter now), privacy (what must never be visible), scoping (who may see it), or cross-person continuity (people leave). Comparative needs memory regardless of window size; what 1M buys is that shell-side compaction can be rare and unhurried.

---

## 3. Recommended memory scopes for Comparative

Generalize the Vault: rename/extend `user_memory_items` into a single `memory_items` concern with `scope ∈ {tool, user, team, org}`, a `subject_id` (skill/app id, user id, group id, or null for org), existing provenance columns (source thread/message), status (`proposed`/`approved`), and `superseded_by` (see below). One table, one gate in `buildTurnContext`, RLS-style scope checks at the query layer (the research is unanimous that access control belongs in the data layer, not application code — and note the warning that if vector embeddings are added later, the *embeddings* need the same access control as the text).

| Scope | What lives there | Author / gate | Injected when |
|---|---|---|---|
| **Org-wide** | org conventions: terminology, Cobalt & Linen-style standards, security/tone rules, "we say Skills not recipes" | Admin-curated only. No AI proposals land here without an admin approving | Every turn, **pinned** (never summarized, re-injected after compaction). Hard budget ~200 lines — the MEMORY.md finding applies: short pinned context beats long ignored context |
| **Per-team** | Team conventions, promoted knowledge ("our vendor codes live in X," "monthly report format is Y"), memory attached to team-shared Skills | Members propose (or promote from personal); team owner/steward approves | Turns where the user's group membership matches; budgeted |
| **Per-user** | Today's Vault: preferences, style, role context | AI proposes from transcripts (existing capture queue); **user approves** — unchanged | Every turn for that user (existing Personal Context block) |
| **Per-tool** | What a specific Skill/App has learned: parameter quirks, data-source caveats, "column X in that Databricks table is stale" | AI proposes during runs of that tool; tool owner approves | Turns/runs that mount that Skill/App. **Memory follows the artifact:** when a Skill is shared, its approved tool-memory travels with it (recipients run with their own credentials but inherit the tool's accumulated knowledge) |

Two rules that fall out of the research:

- **Supersede, don't erase.** Corrections create a new item with a pointer to the superseded one (Cloudflare's version-chain pattern; the governed-memory paper's "if a false memory is silently overwritten, the system loses the lesson that the earlier record failed"). This also gives the audit ledger something honest to point at.
- **Consumer template, developer garnish.** For per-user and per-tool scopes, the Claude.ai model wins outright for the org's users: relevance-filtered, single visible summary, editable in plain language, pause/reset, incognito. The developer model (explicit authored files) survives only at the org and team scopes, where deliberate human authorship is exactly what's wanted. **Position taken:** do not offer employees a CLAUDE.md-style file to maintain; they won't, and the ETH data says the AI shouldn't maintain one for them unsupervised either.

---

## 4. Personal vs. team memory: team definition, promotion, continuity

### 4.1 What is a "team"?

**Recommendation: both models, one substrate, IdP-seeded.** The automatic backbone is **PingOne/PingFederate OIDC group claims** (the org's actual structure — departments, reporting lines, AD security groups), which is the same identity layer that prompt #3's connector-governance work must consume for "who may reach this tool." On top of that, allow **self-formed teams** (project squads, cross-functional groups) as first-class groups in the same table — the `shares` table already implies this concept; formalize it rather than inventing a second one. The research found the two models are complements everywhere they appear (enterprise wikis, MindStudio's "defined groups," RLS-membership systems), not alternatives. The critical property is **membership checked at query time against live IdP state** — the named failure mode is stale membership data, and the named fix is SCIM/webhook sync, which the org's Ping deployment provides.

**Do not build a second permission hierarchy.** Answering the synthesis question directly: shared-memory visibility and connector access must ride the *same* group substrate. Every argument for splitting them is aesthetic; every failure mode (drift, orphaned grants, audit confusion, double offboarding) comes from splitting them.

### 4.2 How does something move from personal to shared?

**Recommendation: explicit action + lightweight review. Never automatic.**

- Personal → team: the *creator* explicitly promotes an item; a team steward (owner of the group, or any designated approver) confirms. This is the governed-memory paper's "human-ratified selection" regime, and MindStudio's default-private-with-gated-promotion — the two independent sources agree.
- Team → org: admin curation only.
- **The mechanism differs by kind, as the prompt suspected:** "a fact Claude noticed about how I work" should essentially never promote (it's personal by nature); "a tool I deliberately built for others" promotes via the existing Skill/App **share flow, carrying its tool-scoped memory with it** — the share *is* the promotion, no separate ceremony. Sharing a Skill should present its approved tool-memory for review as part of the share step, so the owner consciously ships what the tool "knows."
- Automatic promotion ("built under a team's project → team-visible by default") is rejected: sensitivity classification is not reliable enough to skip a human (the research recommends a classifier *before write* as a floor, not as a substitute for review), and the false-memory-persistence evidence says unreviewed AI content should not become other people's ground truth.

### 4.3 Continuity: departures and new hires

**Departure — recommendation:**
- **Shared stays.** Anything promoted to team/org persists regardless of who created it, authorship preserved in provenance/audit (Adaptive Recall's model; also matches how every enterprise treats documents). Optionally anonymize attribution on request ("Sarah decided" → "the team decided") for GDPR-style erasure without destroying institutional knowledge.
- **Personal is not retained.** On deprovisioning (Ping/SCIM event — the same event that kills their OAuth tokens and attestations), personal-scope memory is disabled immediately and purged after a retention grace window (suggest 30 days, aligned with whatever `audit_log` retention lands on).
- **"Leaves with them" means non-retention, not export.** Flagging the tension plainly, as the prompt asks: the working assumption that personal memory is the individual's property to take is **in direct conflict with standard enterprise IP posture** — work product created on company systems, about company data (vendor spend, Salesforce accounts), is company property, and exporting it to a departing employee could itself be a data-loss event. The defensible reading of the intent is: *the org doesn't keep it, and the person doesn't take it either.* An export path should exist only if Legal/HR explicitly blesses one. **This is a sign-off item outside Comparative's team — do not resolve it in code.**
- **Pre-departure promotion prompt, not post-departure mining.** The Adaptive Recall pattern of reviewing a leaver's personal namespace for org value has its own privacy problem (someone reading a colleague's private memory). Prefer: offboarding checklist prompts the *departing user* (while still provisioned) to promote anything the team needs. What they don't promote, dies. The "preservation paradox" (the most valuable knowledge sits in the most personal namespaces) is real, but the answer is culture + the promotion UX being cheap, not post-hoc surveillance.

**New hire — recommendation:** inheritance is **automatic and instant** via the same substrate: provisioning into Ping groups grants read access to that team's shared memory and org memory on first login — no manual pointing, no per-item grants. This is the mirror image of departure by construction, because both are just group membership evaluated at query time. (The vendor claim that this collapses 3–6-month onboarding to day-one context is marketing, but the direction is obviously right and it costs nothing extra once scopes exist.)

---

## 5. Compaction & checkpoint strategy

### 5.1 Compaction

**Current state:** `buildTurnContext` applies deterministic drops/truncation (message-count, total-char, per-message-char limits) with structured logs; the rolling `chat_threads.summary` column and helper exist but generation is unshipped. Deterministic dropping is silent context *loss*; it needs the summary layer to become context *compression*.

**Recommendation — two phases:**

1. **Now: ship shell-side rolling summarization** (finish the pending feature) as Comparative's compaction. The shell owns context assembly per the ownership rule, this works uniformly across both runtime lanes, and the server-side alternative is blocked anyway: per AWS documentation, the compaction beta is **not supported by the Converse API** (InvokeModel only) and only on a model subset — Comparative's fast lane is `converseStream`. Design requirements, straight from the research:
   - **Pin, don't summarize, governance and memory.** Org memory, team memory, the Personal Context block, and the Skill's system prompt are *never* inside the summarized region and are re-injected intact after every summarization (the +0-decay finding for preserved system-position content; constraint pinning's 0%-violation result). Only conversation history gets summarized.
   - **Harden the summarizer against injection.** The compaction step is a demonstrated attack surface (0%→65% under searched injections). The transcript being summarized contains tool outputs and user-pasted content — frame it as data with the existing nonce-delimited pattern, and never let summarizer output alter the pinned region.
   - **Preserve the current user message exactly** (already an invariant — keep it).
   - Log summarization events like the existing `turn-context-guardrail` events, and keep raw messages in `chat_messages` (compaction changes what's *injected*, never what's *stored* — the audit ledger and activity replay depend on this).

2. **Later: adopt `compact_20260112` behind the runtime seam** when/if Bedrock supports it on the Converse path (or for the AgentCore/InvokeModel worker lane first, where long scheduled runs are the actual pain point). When adopting: use `pause_after_compaction` to re-inject the pinned region; remember custom `instructions` *replace* the default prompt entirely; and account for billing via `usage.iterations` (invisible in top-level token counts — this will otherwise silently skew prompt #8's cost-governance numbers) plus the prompt-cache miss it causes.

**What memory must survive compaction by construction:** anything in the four scopes. That's the division of labor Anthropic documents for the Memory Tool pairing — compaction keeps the active context small; memory holds what must outlive it. Comparative gets this for free if scopes are pinned inputs to `buildTurnContext` rather than conversation content.

### 5.2 Checkpoints & undo

**Position (answering the synthesis question):** checkpoints are not memory — they're version control for the session — and Comparative needs them as a first-class capability *regardless* of memory decisions, because its core J4 promise is non-technical users iterating on tools they will break.

**Recommendation:**
- **Apps: already 80% there.** `app_versions` version groups + plain-language revert is exactly the Claude Code "local undo" pattern. Keep automatic versioning on every agent edit session (every deploy and every accepted edit-session outcome = a checkpoint), with plain-language version descriptions.
- **Skills: add the same.** A `skill_versions` history (definition snapshot per save) with one-click revert. A Skill edited into a broken state is currently unrecoverable except by memory of what it said.
- **Decouple artifact-restore from conversation-restore,** per the Claude Code rewind design: "put my app back how it was" must not delete the chat where the user explains what went wrong. Ship artifact-restore first; conversation rewind (restoring a thread to an earlier message, which the branch-replacement machinery for edit-and-resend already half-implements) is a later, separate feature.
- **Retention:** mirror the 30-day default for fine-grained checkpoints, but never expire *deployed* app versions (those are releases, not checkpoints — the Git-vs-checkpoint distinction).
- **Honest coverage limits:** version the things Comparative renders and deploys. Do not promise undo for side effects in external systems (a sent email, a created ticket) — that's the human-in-the-loop confirmation feature's job (already on the roadmap), not rollback's.

---

## 6. Privacy & exclusion rules

Given what flows through this system (vendor spend, Salesforce accounts, HR-adjacent chat), these are hard rules, not preferences:

1. **Nothing persists to memory without the user's knowledge.** The proposed→approved gate stays for all AI-captured memory in every scope. No silent auto-memory. (This is where Comparative deliberately diverges from Claude Code's on-by-default auto memory and sides with Claude.ai's review-and-edit posture.)
2. **A single "what Comparative knows about me" surface** — extend the Vault UI to show every memory item in every scope the user can see, with edit/delete in plain language, per-scope pause, and full reset. Deletions propagate to future turns immediately and to any derived summaries within 24h (Claude.ai's benchmark).
3. **Ephemeral (incognito) threads:** a per-thread toggle that suppresses memory capture and thread-summary generation entirely. **Be explicit about the boundary: incognito excludes *memory*, not *audit*.** Tool executions in an incognito thread still write `audit_log` rows — the org's compliance ledger cannot have a user-controlled off switch. Say so in the UI. (Precedent: Claude.ai incognito chats still retain data ≥30 days for safety/legal.)
4. **Sensitivity screening before proposal.** The memory-capture worker runs a classification step before creating a proposed item; categories like credentials/tokens (already never persisted), individual compensation/HR data, and named-vendor pricing default to *not proposed*. Reuse the existing tool-payload redaction pipeline. Classifiers are a floor, not the gate — the human approval step remains the actual control.
5. **Scope isolation is structural.** Team/org reads enforced at the data layer against live group membership (query-time checks, per §4.1) so a scope leak requires a schema bug, not a prompt bug. Memory content injected into prompts is framed as data (existing nonce pattern) — an approved memory item must not be able to carry instructions ("ignore your rules…") into future turns; approval review is also injection review, which is another reason humans stay in the loop.
6. **Admin kill switch.** An org admin can disable memory capture org-wide; disabling deletes derived syntheses (Claude.ai Enterprise sets the precedent that disable = delete, not merely pause). Per-user memory data is included in whatever retention/redaction regime lands for `audit_log` and chat (§9 of the tech overview lists this as open — memory must be in that decision, not bolted on after).

---

## 7. Open questions & risks

1. **Legal/HR sign-off on departure semantics** (§4.3). Whether any export path exists for a departing employee's personal memory is a company-policy question. Blocked on someone outside the eng team.
2. **Bedrock support for server-side compaction on Converse.** The InvokeModel-only claim is from AWS docs fetched 2026-07-12 (unverified by vote — quota); re-verify before planning phase 2 of §5.1, and check the supported-model list against Comparative's Sonnet 4.6 pin (current docs list Sonnet 4.6 as supported on Bedrock, which is convenient).
3. **Injection budget of injected memory.** Every approved memory item is standing prompt content. Budgets per scope (org ~200 lines; team/user/tool smaller) need real numbers once usage data exists — Agent Wire (when unblocked) should track memory-block token share per turn.
4. **Retrieval vs. always-inject.** This spec recommends always-inject within budgets (small, curated scopes). If scopes outgrow budgets, the next step is relevance retrieval (the Memory Tool / just-in-time pattern) — at which point embeddings inherit the same access controls as text (§3). Don't build retrieval speculatively.
5. **Team-steward workload.** Human-gated promotion has a named cost in the research: ratification bottlenecks and reviewer bias. If promotion queues rot, the fallback is *narrowing what's proposable*, not removing the human.
6. **Evidence-strength caveat.** The governed-memory paper's empirical base is tiny (12 event records, one operator) and self-disclaims causal claims; the compaction-safety study is a controlled benchmark, not production data; vendor onboarding claims (3–6 months → day one) are marketing. The *directional* consensus across independent sources is what this spec leans on.
7. **Cross-scope confidentiality edge:** a user in teams A and B could promote A-derived knowledge into B. The promotion review step is the control; whether provenance should *block* cross-team promotion of items derived from another team's connector data is a governance question to settle alongside prompt #3.

---

## 8. Sources (with dates)

**Primary vendor documentation** (all fetched 2026-07-12):
- Claude Code memory docs — https://code.claude.com/docs/en/memory (CLAUDE.md hierarchy, compact-survival asymmetry, MEMORY.md 200-line/25KB budget, enforcement boundary) — core claims verified 3–0
- Claude Code checkpointing docs — https://code.claude.com/docs/en/checkpointing (checkpoints, rewind menu, targeted summarization, coverage gaps) — verified 3–0
- Claude API compaction docs — https://platform.claude.com/docs/en/build-with-claude/compaction (`compact_20260112`, header `compact-2026-01-12`, 150K/50K trigger, `pause_after_compaction`, `usage.iterations`) — verified 3–0
- Claude API context editing — https://platform.claude.com/docs/en/build-with-claude/context-editing (`clear_tool_uses_20250919`, memory-tool integration) — verified 3–0
- Claude API Memory Tool — https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool (`memory_20250818`, client-side execution, security responsibilities, multi-session pattern) — verified 3–0
- Claude context windows — https://platform.claude.com/docs/en/build-with-claude/context-windows (1M default, context rot, context awareness) — partially verified
- Anthropic cookbook: context engineering — https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools (layer-selection framework, compaction benchmark: 335K→169K peak, high-level facts 3/3 survived, specifics 0/3) — unverified by vote (quota), primary source
- AWS Bedrock: Claude messages compaction — https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-compaction.html (InvokeModel-only, model subset, billing) — unverified by vote (quota), primary source; **re-verify before relying on it**
- Anthropic: "Bringing memory to teams" — https://www.anthropic.com/news/memory (published 2025-09-11; Pro/Max expansion 2025-10-23)
- Claude help center: memory & chat search — https://support.claude.com/en/articles/11817273 (~24h synthesis, project scoping, incognito, admin disable = delete)

**Studies:**
- Compaction-safety study — arXiv 2606.22528 (June 2026): violation rates under compaction, layer-placement decay (+0/+50/+45/+33), constraint pinning, summarizer injection
- Governed multi-agent memory — arXiv 2605.04264 (May 2026): four-layer architecture, four selection regimes, false-memory persistence, supersede-not-erase; small evidence base self-disclaimed
- ETH Zurich context-file study — arXiv 2602.11988 (Feb 2026): LLM-generated context −3% success/+20% cost; human-written +4%
- Princeton Codex/AGENTS.md study (via morphllm guide): −28.6% runtime, −16.6% tokens across 124 PRs
- Liu et al., "Lost in the Middle" (Stanford, 2023): 15–20-point positional accuracy drop

**Secondary / practitioner** (quality-flagged in workflow):
- ChatGPT/Claude Code/Gemini memory comparison — https://knightli.com/en/2026/05/07/chatgpt-claude-code-gemini-memory-comparison/ (2026-05-07)
- AGENTS.md vs CLAUDE.md vs Cursor rules — https://codersera.com/blog/agents-md-vs-claude-md-vs-cursor-rules-comparison-2026/ (2026)
- AGENTS.md guide — https://www.morphllm.com/agents-md-guide (Codex 32 KiB cap, Linux Foundation stewardship, adoption stats)
- Claude Code memory guide — https://skillsplayground.com/guides/claude-code-memory/ ("Updated Feb 2026")
- Claude Code context management — https://angelo-lima.fr/en/claude-code-context-memory-management/ (2025-12-15)
- Harness rules-file compendium — https://gist.github.com/0xdevalias/f40bc5a6f84c4c5ad862e314894b2fa6 (Codex/Copilot/Amp/JetBrains loading models)
- VentureBeat on Claude Team/Enterprise memory — https://venturebeat.com/ai/anthropic-adds-memory-to-claude-team-and-enterprise-incognito-for-all (Sept 2025)
- Enterprise memory at departure — https://www.adaptiverecall.com/enterprise-memory/employee-leaves.php (vendor; namespace lifecycle, SCIM, anonymization)
- Shared team agent memory — https://www.mindstudio.ai/blog/share-ai-agent-memory-across-team (vendor; three-tier scopes, RLS, default-private promotion)
- Multi-agent memory architectures — https://zylos.ai/research/2026-03-09-multi-agent-memory-architectures-shared-isolated-hierarchical/ (2026-03-09; global/group/private convergence, zero-trust memory)
- Context rot — https://redis.io/blog/context-rot/ (attention dilution, external-memory pattern)
- Cloudflare Agent Memory & Databricks agent-memory posts (via extraction; four memory types, supersession chains, episodic/semantic split, MemAlign results)

### Verification notes

The deep-research workflow adversarially verified the top 25 of 115 extracted claims with 3 independent refutation votes each: **14 confirmed 3–0, 0 refuted**. 11 claims went unverified because verification agents hit org spend/session limits — all 11 are direct quotes from primary Anthropic/AWS documentation and are used above with that caveat where load-bearing (notably the Bedrock Converse limitation). No claim in this spec was contradicted by any verifier.
