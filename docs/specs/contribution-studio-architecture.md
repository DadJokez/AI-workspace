# Comparative Contribution Studio

**Status:** Planning spec - no implementation
**Date:** 2026-08-09
**Research reference:** [Omnigent](https://github.com/omnigent-ai/omnigent), reviewed read-only at commit `c2167000`
**Product intent:** Create a governed space where knowledge workers combine their knowledge, company resources, and Comparative's capabilities to inspect work, explore alternatives, and make their greatest contribution.

## 0. GitHub Tracking

**Epic:** [#735 - Contribution Studio: inspect, steer, review, and govern agent work](https://github.com/DadJokez/AI-workspace/issues/735)

| Track | Issue |
| --- | --- |
| Queue and steer | [#737](https://github.com/DadJokez/AI-workspace/issues/737) |
| Context Shelf and resource mentions | [#738](https://github.com/DadJokez/AI-workspace/issues/738) |
| Deliverable review mode | [#739](https://github.com/DadJokez/AI-workspace/issues/739) |
| Studio shell and Live Work Map | [#740](https://github.com/DadJokez/AI-workspace/issues/740) |
| Branch this work | [#741](https://github.com/DadJokez/AI-workspace/issues/741) |
| Command Palette 2.0 | [#742](https://github.com/DadJokez/AI-workspace/issues/742) |
| Layered Studio guardrails | [#743](https://github.com/DadJokez/AI-workspace/issues/743) |
| Runtime capability conformance | [#744](https://github.com/DadJokez/AI-workspace/issues/744) |

## 1. Decision

Comparative should remain one simple, AWS-governed assistant rather than become a user-facing meta-harness. We should adopt the interaction patterns that make long-running agent work understandable and controllable:

- a persistent Contribution Studio beside chat;
- explicit resources and context;
- editable queued follow-ups and mid-run steering;
- user-legible work steps backed by structured events;
- reviewable, versioned deliverables;
- safe branching for alternate approaches;
- one capability palette across product surfaces;
- visible policy, approval, and budget state; and
- an executable conformance suite that proves runtime capabilities.

The user should never need to choose a harness, model, MCP server, or worker. Comparative continues to route execution behind `AgentRuntime` and presents one coherent product.

## 2. Product Translation

| Developer-harness primitive | Comparative knowledge-work equivalent |
| --- | --- |
| Repository files | Uploads, Vault documents, artifacts, app files, and connector-derived resources |
| Browser pane | Generated-app preview, web research evidence, screenshots, and isolated agent browsing |
| Terminal | A contextual Console for app-building or technical work; a user-friendly Studio view for everyone else |
| Tool trace | Concise work steps, evidence, approvals, and receipts |
| Git diff | Artifact/document version comparison and proposed changes |
| Worktree or session fork | Branch this chat, artifact, or app into an independent line of work |
| Subagent tree | Hidden specialist workers surfaced as labeled steps, not vendor/model identities |
| Harness policies | Organization, Agent/Skill, and session guardrails |

## 3. Experience Model

### 3.1 Chat remains the front door

Simple questions remain simple. Direct chat should not gain extra ceremony, panels, or status rows when no meaningful work is happening.

When a turn creates or inspects resources, calls tools, or runs long enough to benefit from inspection, Comparative makes **Studio** available. The switch is contextual rather than a permanent model or tool toggle.

### 3.2 The Contribution Studio

The current resizable preview pane evolves into the persistent **Contribution Studio**, shortened to **Studio** in compact UI, with stable tabs:

- **Preview** - rendered artifact, document, dataset, image, PDF, or app.
- **Files** - the resources in scope for this thread or project.
- **Browser** - isolated browser pages, screenshots, citations, and app verification.
- **Activity** - current plan, completed steps, tool receipts, evidence, approvals, timing, and cost.
- **Console** - only when the active task owns a sandboxed execution environment.

Opening the Studio must resize chat rather than cover it. Tabs appear only when the run has the corresponding capability or content. The Studio remembers width and the last useful tab per user, within responsive limits.

### 3.3 Chat and Studio modes

- **Chat** prioritizes the conversation and final deliverables.
- **Studio** prioritizes the active resources, deliverables, and run while keeping the conversation available.
- **Console** is not a global product mode. It is an optional Studio tab for technical tasks.
- Comparative may suggest or open Studio when a user asks to build, analyze, compare, or investigate, but the user can always return to Chat.

### 3.4 Studio identity and motion

Chat and Studio are related but distinct Comparative surfaces:

- **Chat** uses the existing Comparative Orb: one soft, imperfect, closed loop that continuously reshapes itself to communicate intelligence that is alive, conversational, and adaptive.
- **Studio** uses an open four-corner frame: four hand-drawn, slightly irregular strokes with generous negative space that communicate knowledge being organized, focused, and turned into durable work.

The marks share the Orb's monoline weight, softened geometry, subtle asymmetry, and Umber token colors. Studio endpoints are organic rather than perfect pill caps, and the mark must not collapse into a generic crop, scan, dashboard, terminal, or application-window icon. Product UI uses **Contribution Studio** as the full name and **Studio** in compact labels.

Motion contract:

- when Studio opens, the four corners arrive independently from their corresponding quadrants, with a quiet stagger, slight rotation/scale variation, and a soft overshoot before settling;
- the production entrance plays once rather than repeatedly disassembling;
- while Studio is actively working, the settled strokes may use the same low-amplitude, hand-drawn morph language as the Orb without spinning or distracting from the work;
- an inactive Studio mark is static;
- `prefers-reduced-motion` always receives the settled static frame; and
- colors come from the Umber design system through `currentColor`; no cobalt-specific treatment is introduced.

The production mark should live beside the Orb in the Umber design system so navigation, loading states, empty states, and future surfaces share one implementation.

## 4. Feature Tracks

### Track 1 - Queue and steer

When a run is active, additional messages remain editable queued drafts until sent.

Required behavior:

- queue multiple follow-ups per thread;
- edit, delete, and reorder unsent items;
- auto-send the head when the run becomes idle;
- offer **Apply now** to steer the current run at its next safe boundary;
- distinguish steering from canceling;
- preserve queued drafts across reload and navigation;
- never steer a run that is waiting on a human approval; and
- reconcile optimistic UI with persisted messages without duplicates.

The runtime contract must state whether live steering is supported. If it is not, **Apply now** sends the message as the next turn and the UI says so honestly.

Reference: [Omnigent queue and steer design](https://github.com/omnigent-ai/omnigent/blob/main/docs/QUEUE_STEER_DESIGN.md).

### Track 2 - Context Shelf and resource mentions

Every turn should make its active resources understandable.

The composer gains an `@` resource picker for:

- current-thread uploads and artifacts;
- Vault items the user can access;
- app versions;
- saved connector resources such as an email thread, calendar event, GitHub item, or Salesforce record; and
- project resources if projects ship later.

The composer shows selected resource pills. The assistant turn shows a compact context receipt such as:

`Using 3 files, Vault profile, Gmail, and Salesforce`

The receipt expands into the exact resource identities, versions, connection state, and scope used for that turn. It must distinguish:

- selected and included;
- selected but unavailable;
- discoverable but not mounted;
- blocked by policy;
- omitted because of size or context budget; and
- generated during the run.

This is a deterministic manifest produced by context assembly, never model-authored narration.

### Track 3 - Deliverable review mode

Artifacts become reviewable work products rather than download-only files.

Required behavior:

- rendered and source views where the format supports them;
- compare any two versions with a format-appropriate diff;
- anchored comments on a stable version;
- open/addressed comment state;
- **Address with Comparative** to create a scoped follow-up from one or more comments;
- accept, discard, or iterate proposed unattended output;
- deep links to an artifact version or comment;
- attribution and audit for comments and decisions; and
- explicit stale-base handling when the live version changed during review.

First-class formats should follow observed user demand. Markdown, text, HTML, and app artifacts are the initial editable/diffable set. Office documents, spreadsheets, PDFs, and images may begin with rendered preview plus comments before native editing exists.

This track extends the proposal contract shipped in #437 and the review inbox planned in #620. It does not replace tool-call approval in #410.

### Track 4 - Contribution Studio shell and Live Work Map

The Activity tab translates structured run events into a useful work map.

Default user view:

- planned, active, completed, waiting, failed, and canceled steps;
- concise labels such as `Reading Gmail`, `Comparing documents`, or `Verifying figures`;
- safe source and output links;
- approvals and decisions;
- elapsed time and deterministic phase; and
- child-worker steps when orchestration is active.

Admin drilldown:

- run and child-run identifiers;
- runtime/model route;
- redacted context manifest;
- tool calls and policy decisions;
- evidence references;
- token, latency, and cost attribution;
- retries, lease ownership, cancellation, and failure details; and
- replay or trace links where retention policy permits.

Only observable structured events are displayed. Comparative must never expose or claim to expose hidden chain-of-thought, private reasoning tokens, raw prompts, secrets, or unredacted connector payloads.

This builds on shipped work receipts (#49 and #359), the Run Inspector, and the future runs tree (#423) and Accountable Runtime (#493).

### Track 5 - Branch this work

Users can explore an alternate direction without mutating the original context or deliverable.

Supported branch points:

- a user or assistant message;
- a current chat state;
- an artifact/app version; and
- a proposal under review.

A branch receives an explicit parent pointer and a snapshot of the permitted context at that point. Later messages, queued drafts, approvals, and tool results do not leak between branches. The UI uses business language such as **Try another approach** or **Branch this work**, not git terminology.

Branches are independent by default. A future compare/promote flow may bring a chosen artifact version back to the source, but automatic conversation merging is out of scope.

### Track 6 - Command Palette 2.0

The shipped global command palette (#520) expands from navigation into a capability and resource launcher.

It should search and act on:

- chats, Skills, Agents, Apps, artifacts, and Vault items;
- available tools and connections;
- pending proposals and approvals;
- Studio resources and comments;
- common actions such as new chat, upload, branch, open Studio, connect a tool, or run a Skill; and
- admin surfaces only when the current user is authorized.

Results must be permission-filtered before rendering. Search snippets must not leak content from inaccessible resources. `/` remains the in-composer Skill/capability picker; `Cmd-K` is the global navigation and action surface.

### Track 7 - Layered guardrails in the Contribution Studio

The existing policy roadmap becomes user-legible at the point of work.

Policy layers:

1. organization/admin policy;
2. Agent or Skill policy;
3. session/task policy; and
4. per-action approval state.

Effective policy follows **most restrictive wins**. A lower layer may narrow capability but may not weaken an administrator block. User-visible states are:

- allowed;
- approval required;
- blocked; and
- unavailable because the user lacks a connection or attestation.

Studio requirements:

- show why an action is waiting or blocked;
- identify the governing layer without exposing sensitive policy internals;
- show scoped standing approvals and expiry;
- show run budget consumption and a truthful budget-reached state;
- batch compatible approvals without collapsing individual audit receipts; and
- keep destructive or cross-system actions explicit.

Implementation rides the deterministic engine in #410, named autonomy presets in #436, and budget enforcement in #493. Prompt instructions are not an enforcement boundary.

Reference: [Omnigent policy layering](https://github.com/omnigent-ai/omnigent/blob/main/docs/POLICIES.md).

### Track 8 - Runtime capability conformance suite

Comparative needs a small executable contract suite in addition to end-user behavioral evals.

Each enabled runtime/model lane earns a verdict for:

- basic turn completion;
- multi-delta streaming and first-token timing;
- text and image/file input;
- tool calling and result continuation;
- tool allow/approval/block enforcement;
- cancellation and no-post-cancel persistence;
- queued next-turn delivery;
- live steering, if declared;
- resume/reconnect;
- context compaction or bounded-context fallback;
- artifact creation and attachment integrity;
- usage/cost reporting; and
- malformed or interrupted stream handling.

The suite compares declared capabilities with observed behavior. A mismatch is **DRIFT** and blocks enabling that runtime for the affected lane. Missing credentials may skip a live probe, but must not be interpreted as unsupported behavior.

Outputs:

- machine-readable JSON scorecard;
- concise Markdown/admin matrix;
- current runtime/model/version provenance; and
- CI or scheduled-run status with a clear separation from broad behavioral evals.

This complements #301. Model quality answers "how well does it perform?"; conformance answers "does the execution contract actually work?"

Reference: [Omnigent harness capability bench](https://github.com/omnigent-ai/omnigent/blob/main/docs/harness-bench-design.md).

## 5. Architecture Boundaries

### Reuse

- `workspace_artifacts` and app versions for files and deliverables;
- `runs` and `run_events` for Activity and Work Map state;
- Run Inspector trace normalization and redaction;
- output proposal metadata and iteration flows;
- the shipped Command Palette provider and action registry;
- `audit_log` for policy, review, branch, and approval events;
- `AgentRuntime` for runtime portability; and
- the existing context-pack receipt and attachment integrity helpers.

### New concepts that may require persistence

- branch lineage;
- queued draft messages if cross-device durability is required;
- stable resource references for connector objects;
- artifact comments and anchors; and
- Studio user preferences.

No schema migration is authorized by this planning spec. Each implementation issue must first show whether existing metadata can safely carry its P0 behavior. Any migration follows repository approval and handwritten migration rules.

## 6. Security and Enterprise Rules

- The Browser is isolated from the user's personal browser profile and ambient cookies.
- Connected systems are accessed through governed MCP/API integrations, not browser-session scraping.
- Console access exists only inside a task-owned sandbox with deny-by-default filesystem, network, environment, and credential scope.
- OAuth credentials never enter generated files, browser content, or the Console environment.
- Resource search and mentions are authorization-filtered server-side.
- Context receipts expose safe labels and versions, not raw hidden prompt material.
- Work Map events are structured, redacted, and persisted according to retention policy.
- Branches copy only authorized snapshots and never bypass current access checks.
- Comments, approvals, policy decisions, and version promotions are attributable and auditable.

## 7. Delivery Sequence

### Tranche A - Control and context

1. Context Shelf and resource mentions.
2. Queue and steer.
3. Contribution Studio shell with Activity using existing run events.

### Tranche B - Inspect and review

1. Files/Preview/Browser Studio tabs.
2. Deliverable comments and version comparison.
3. Branch this work.

### Tranche C - Govern and prove

1. Layered policy and budget explanations.
2. Runtime conformance suite.
3. Command Palette resource/action expansion.

The exact build order remains subordinate to enterprise hardening work and dependencies called out in the GitHub epic.

## 8. Success Measures

- fewer turns where users ask what Comparative can see or whether a tool is connected;
- fewer reruns caused by missing or stale context;
- successful follow-up steering without cancellation or duplicate messages;
- lower time from generated deliverable to accepted version;
- measurable use of comments, diffs, and branch exploration;
- zero unauthorized resource names leaked through search or context receipts;
- zero persisted output after a conformance-tested cancellation; and
- zero runtime capability marked available while its live probe reports drift.

## 9. Non-goals

- a user-facing model or harness picker;
- raw chain-of-thought or every model token;
- unrestricted access to the user's machine or browser profile;
- a general-purpose IDE for every employee;
- simultaneous collaborative editing in the first release;
- automatic merging of chat branches;
- exposing subagent vendors or implementation details; and
- replacing deterministic product policy with prompt instructions.
