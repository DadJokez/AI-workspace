# Desktop Parity Backlog

> **The bar:** an enterprise knowledge worker should never feel a reason to
> open ChatGPT, Claude Desktop, or a personal Copilot instead of AI Hub. Every
> gap below is a reason someone reaches for a shadow tool — and shadow tools
> are the exact risk the paved road exists to eliminate. So this backlog is a
> security argument as much as a product one.
>
> **First audience (decided):** mixed knowledge workers — PMs, analysts, ops,
> some engineers. The parity anchor is **Claude Desktop** (projects, files,
> memory, artifacts), not Codex. Coding-power features are a second track.
>
> Status legend: ✅ shipped · 🔄 partial · ⬜ not started. Each item notes the
> gap, why it drives shadow-tool use, and rough size (S/M/L).

## What we already have (the moat is real)

These are *ahead* of the consumer apps and worth saying out loud in any demo:

- ✅ **Real work-system tools, governed** — GitHub MCP per-user, attestation-gated, every call audited. Claude Desktop can't see your PRs; AI Hub can.
- ✅ **Skills** — saved, shareable, schedulable agents with a "/" palette. This is Claude Projects + a cron + sharing, in one primitive.
- ✅ **Apps** — deploy a tool from chat, SSO-gated. No consumer app does this.
- ✅ **Schedules** — proactive agents. No consumer app does this.
- ✅ **AgentCore substrate** — execution in our own AWS account. The enterprise answer to "where does our data go."
- ✅ **Work receipts, audit, redaction** — the governance the consumer apps lack.

The parity gaps below are mostly **table-stakes input/context features** the
consumer apps have trained everyone to expect — not capability gaps.

## Tier 1 — Table stakes (close these first; each is a daily shadow-tool trigger)

### P1.1 ✅ File & image upload into chat — **business formats shipped**
- **Have:** picker, drag/drop, and paste accept PDF, DOCX, XLSX, CSV/TSV, PPTX, PNG/JPG/WebP, TXT/MD, HTML, JSON/XML/YAML, logs, and common code/text files. Modern Office/PDF/spreadsheet/deck files are extracted server-side; screenshots/images are passed to Bedrock as native image blocks; uploads are stored in Artifacts with the original type and download preserved.
- **Guardrails:** request/file byte caps, extracted-text caps with truncation, no-secrets scan before storage/runtime prompt, clear unsupported messages for legacy `.doc/.xls/.ppt`.
- **Remaining:** OCR fallback for scanned PDFs and native parsing for old binary Office formats if a customer truly needs them.

### P1.2 ⬜ Projects / workspaces — **L**
- **Gap:** threads are a flat list. Claude Projects bundle threads + persistent instructions + reference files under one context.
- **Shadow trigger:** "I want all my Q3-planning chats and docs in one place with shared context." Weekly.
- **Shape:** a `projects` table (name, instructions, members); threads, uploaded files, and skills can belong to one; project instructions inject into every turn in that project. This is also the natural home for **team context** (see KNOWLEDGE_MANAGEMENT.md).

### P1.3 ✅ Persistent memory the user controls — **shipped**
- **Have:** Vault memory-capture (suggested → approved → injected). Good bones.
- **Gap:** no user-facing "what does the assistant remember about me" surface to view/edit/delete; capture is per-thread, not a durable profile the user curates.
- **Shadow trigger:** "ChatGPT remembers I'm in supply chain; I have to re-explain here every time." (The onboarding wizard, specs/005, seeds this.)
- **Shape:** a Memory page — list, edit, delete, add manual facts; merge with the wizard's role answers.

### P1.4 ✅ Stop / edit / regenerate / branch a turn — **shipped (#153, #332)**
- **Have:** inline Stop, durable-run cancel, regenerate, and edit-and-resend. Regenerate and edits replace the selected persisted user turn, remove the abandoned later branch, clear stale summaries, and run again in the same thread.
- **Guardrail:** messages with uploaded files remain follow-up-only until Comparative can faithfully replay the original file payload during an edited turn.

### P1.5 🔄 Rich artifacts & inline preview — **M**
- **Have:** HTML artifacts deploy as apps; collapsed code/doc previews in chat; workspace artifact pills open the in-tab preview pane; artifact versions are grouped with v2/v3 download and preview support.
- **Gap:** no live side-by-side artifact canvas (Claude Artifacts) — edit-in-place, re-render, copy. The app pane exists for previews but isn't a working canvas.
- **Shadow trigger:** "I want to iterate on this doc/diagram next to the chat."

## Tier 2 — Power & flow

### P2.1 ✅ Voice input (dictation) — **shipped (#159)**
- Browser SpeechRecognition into the composer. Cheap, high-delight, big for mobile/ops users.

### P2.2 ⬜ Global command palette (Cmd-K) — **M**
- Jump to any thread/skill/app/project, start actions. Power-user muscle memory; complements the "/" skill palette.

### P2.3 ⬜ Prompt library / saved prompts — **S**
- Personal + team reusable prompts. A lighter-weight cousin of skills for one-off phrasings. (May fold into skills.)

### P2.4 ⬜ Web search / fetch tool — **M**
- The one consumer-grade capability we lack that everyone expects. Bedrock-side or an MCP fetch tool, attested like any provider.

### P2.5 ⬜ Export & share a thread — **S**
- Export to Markdown/PDF; share a read-only thread link (J5 mechanism extends here). Chat-export lib already exists server-side.

### P2.6 ⬜ Keyboard shortcuts + a11y pass — **S**
- Enter/Shift-Enter exists; add new-chat, focus-composer, switch-thread, and a real a11y sweep for the enterprise bar.

## Tier 3 — Engineer track (the Codex/Claude-Code anchor; second audience)

### P3.1 ⬜ Repo-as-context — **L**
- Point a thread/project at a repo (via GitHub MCP, already live) for grounded code Q&A. Big for the engineer cohort; rides existing auth.

### P3.2 ⬜ Diff & PR review surface — **M**
- First-class PR review (the Developer Briefing skill is the seed) with inline diff rendering.

### P3.3 ⬜ Run code / sandbox — **L**
- Execute generated code in a sandbox (AgentCore can host this). Powerful, heavier; gate behind the engineer cohort's demand.

## Sequencing recommendation

1. ~~**P1.1 file upload** — single biggest shadow-tool plug; reuses the artifacts substrate.~~ **Shipped for modern business formats.**
2. ~~**P1.4 stop/edit/regenerate** — cheap, removes daily friction, very visible.~~ **Shipped.**
3. **P1.2 projects** — unlocks team context (the knowledge-management story) and is the container everything else hangs on.
4. ~~P1.3 memory surface + specs/005 onboarding~~ — **shipped** (onboarding #150, memory view/edit/delete + add-a-fact).
5. Then Tier 2 by demand signal (voice and web-search tend to top knowledge-worker asks).

Reassess after the first cohort is live — usage tells you which Tier 2/3 items are real vs. assumed. The eval harness (specs/004) gates each of these as it lands.
