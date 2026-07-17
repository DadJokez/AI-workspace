# Skills & Extensibility Packaging for Comparative (AI Hub)

**Status:** Research spec — no implementation. Produced from prompt `02-skills-extensibility-research-prompt.md`, grounded against `TECHNICAL_OVERVIEW.md` (July 2026 snapshot of `ai-workspace`).
**Research method:** deep-research harness — 5 search angles, 23 sources fetched, 114 claims extracted, top 25 adversarially verified (3 independent refutation votes per claim): **15 confirmed, 0 refuted**, merged into 10 findings. Claims outside the top-25 verification budget are cited below as *extracted, not adversarially verified* — each still carries a verbatim quote from its source. All URLs live as of **2026-07-12**.
**Date:** 2026-07-12

---

## 0. Grounding: what Comparative already has

- Comparative's reusable unit already exists: **Skills** (née "recipes") — Postgres rows (`skills` table) holding system prompt, model, MCP server slugs, allowed tools, params schema, optional schedule. Runs flow through the generalized `runs` ledger with full audit.
- Skills already run three ways: manual, scheduled (cron, leased tick), and event-triggered (signed GitHub webhooks) — i.e., Comparative Skills are *more* than instruction packets; they carry execution wiring no open format covers.
- Sharing is seeded: named-teammate `shares` where **recipients run with their own credentials** and owners revoke. No org-wide catalog, search, categories, or adopter-update story yet (J5, #78). Catalog cold-start is a named open question (§10.5 of the overview).
- An export/import/clone surface exists (`skills/[id]/export`, `skills/import`, `skills/[id]/clone`) — the natural seam for any portable-format bridge.
- Governance spine that constrains everything below: **all capability is MCP tools**, gated per-user by attestations + admin `tools_catalog`, with redacted audit rows. A shared Skill carries *references* to connector access, never credentials.

---

## 1. The SKILL.md / plugin / marketplace pattern, as found in research

### 1a. The format

The **Agent Skills** standard (originated by Anthropic, released as an open standard, now maintained at [agentskills.io](https://agentskills.io/specification) / [github.com/agentskills/agentskills](https://github.com/agentskills/agentskills), Apache 2.0 code / CC-BY-4.0 docs, ~22.9k stars) defines a skill as **a folder containing `SKILL.md`** with YAML frontmatter requiring exactly two fields — `name` (≤64 chars, lowercase/numbers/hyphens, must match the folder name) and `description` (≤1024 chars, non-empty) — plus optional `license`, `compatibility`, `metadata`, and `allowed-tools`. `scripts/`, `references/`, `assets/` are optional bundled resources. *(Verified 3-0 across four primary sources.)*

**Progressive disclosure** is the load model: (1) name+description (~100 tokens/skill) loaded at startup for *all* installed skills; (2) the full body (<5,000 tokens / 500 lines recommended) loaded only on activation; (3) bundled files only as needed. Per-skill bundled context is effectively unbounded; installed-skill *count* still costs startup context. *(Verified 3-0.)*

**Two invocation modes**, both in Claude Code and OpenAI Codex: **explicit** (`/skill-name`; Codex: `/skills` or `$mention`) and **autonomous** — the model matches the task against the `description` and loads the body only after selection. Claude Code adds per-direction restriction: `disable-model-invocation: true` (user-only; for side-effectful workflows like `/deploy`) and `user-invocable: false` (model-only background knowledge). *(Verified 3-0. Caveat: anthropics/claude-code#26251 reports buggy behavior of `disable-model-invocation`.)*

**Description craft is real and documented, cross-vendor** *(verified 3-0)*:
- State **what** the skill does *and* **when** to use it. Spec's poor example: "Helps with PDFs." Good example names trigger phrases: "Use when working with PDF documents or when the user mentions PDFs, forms, or document extraction."
- Include specific keywords users would naturally say — the description is, functionally, the retrieval index for autonomous routing.
- **Front-load** the primary use case and trigger words: Codex "shortens skill descriptions first" when many skills are installed; Claude Code truncates combined `description`+`when_to_use` at 1,536 chars (a configurable default).
- The official **skill-creator** plugin closes the loop with *description tuning*: it generates should-trigger and should-not-trigger prompts, measures hit rate, and proposes description edits on misfires — plus isolated per-test subagent runs, assertion grading, with/without-skill benchmarking, and blind A/B of skill versions. *(Verified 3-0.)*

### 1b. Portability: real at the core, leaky at the edges

| | Format | Invocation | Distribution unit | Portability | Known gaps |
|---|---|---|---|---|---|
| **Claude Code** | SKILL.md, ~16 optional frontmatter fields | explicit `/name` + autonomous | plugin via marketplace; also project/personal/enterprise dirs | base standard + **non-portable extensions** (invocation control, `context: fork` subagents, `` !`command` `` injection) | extensions don't travel; `disable-model-invocation` bug #26251 |
| **OpenAI Codex** | same SKILL.md core (name+description) | `/skills`, `$mention` + autonomous | plugins (optionally bundling connectors) | format-level yes *(verified 3-0)* | discovers from `.agents/skills`, `$HOME/.agents/skills`, `/etc/codex/skills` — **not** `.claude/skills`; relocation/sync needed |
| **GitHub Copilot CLI** | same two required fields | description-driven autonomous | plugin dirs | *reported*: watches `.github/skills/`, `.claude/skills/`, `.agents/skills/` (project) and `~/.copilot/`, `~/.claude/`, `~/.agents/` equivalents — so `.claude/skills/` works unchanged | **single blog source (allaboutken.com, 2026-04-08), not adversarially verified**; `plugin.json` `skills` field breaks Claude Code but not Copilot |
| **Gemini CLI / Cursor / Windsurf** | "variant forms" adopted | — | — | *reported only* (blog claims of 26+ adopting products, Dec 2025) | **no primary-source verification in this run** |

The verified bottom line *(3-0)*: **the portable core is `name` + `description` + Markdown body.** `allowed-tools` is spec-flagged *Experimental* ("support may vary between agent implementations"); `scripts/` language support "depends on the agent implementation"; everything else is vendor extension. "Open standard" is partly self-description — Anthropic remains de facto steward; no independent standards body governs it.

### 1c. Skill vs. subagent vs. hook

The research run confirmed the *components* (plugins bundle "skills, agents, hooks, MCP servers, LSP servers, monitors" — Claude Code plugins reference, verified) but the decision *framework* itself did not survive to a verified claim — treat the following restatement as **consistent with primary docs, not adversarially verified**:

> **Skill** = instructions loaded *into the current context* on demand — same conversation, same memory, model judgment applies. Choose when the value is *know-how* the agent should follow here and now.
> **Subagent** = the work runs in an *isolated context* and only a summary returns. Choose when the work is bulky (context pollution) or needs different tools/permissions.
> **Hook** = a deterministic script at a fixed lifecycle point, *no model judgment at all*. Choose when the behavior must happen (or be blocked) every time, regardless of what the model decides.

For Comparative the mapping is clean: a Comparative **Skill** ≈ skill (+ pinned wiring); Comparative's **worker lanes / future subagents** (§10.6) ≈ subagents; Comparative's **tool gate, attestations, and guardrails** ≈ hooks — deterministic shell-owned policy, exactly where the overview says it must live (the shell, never the runtime).

### 1d. Plugins & marketplaces — the distribution layer

*(All of the following comes from primary Claude Code docs — plugins-reference, plugin-marketplaces — via extraction with verbatim quotes; the marketplace-mechanics claims were outside the top-25 verification budget, so: extracted, not adversarially verified. The anthropics/skills-as-marketplace claim IS verified 3-0.)*

- A **plugin** is a self-contained directory bundling skills (`skills/<name>/SKILL.md`), subagents (`agents/*.md`), hooks (`hooks/hooks.json`), MCP configs (`.mcp.json`), commands, LSP servers. Manifest at `.claude-plugin/plugin.json`; `name` is the only required field and becomes a **namespace prefix** (`plugin-name:skill-name`) preventing collisions.
- A **marketplace** is a git-hosted catalog file (`.claude-plugin/marketplace.json`: `name`, `owner`, `plugins[]` with `source` = relative path / GitHub / git URL / git-subdir / npm, pinnable to a ref or 40-char SHA). Registered once (`/plugin marketplace add owner/repo`), then per-plugin installs. **anthropics/skills itself works this way** *(verified 3-0)*.
- **Strict vs. non-strict** — the curation switch the research prompt asked about **exists**: per-entry `strict: true` (default) means *the author's `plugin.json` is authoritative* and the marketplace entry merely supplements; `strict: false` means *the marketplace operator's entry is the entire definition* — "useful when the marketplace operator wants full control" — and a conflicting author manifest fails the plugin load. This is precisely the knob for a curated internal catalog vs. an open one.
- **Reserved/protected naming exists**: Anthropic reserves official marketplace names (claude-code-marketplace, claude-plugins-official, anthropic-marketplace, agent-skills, …), blocks impersonating variants (e.g. `official-claude-plugins`), and **re-checks reserved names on every marketplace load**, not just at add time (tightened in v2.1.205). Skill `name` fields likewise cannot contain "anthropic" or "claude".
- **Enterprise controls**: `strictKnownMarketplaces` managed setting (empty array = total lockdown; allowlist with host/path regex; user-unoverridable); `disableSkillShellExecution: true` kills skill shell execution org-wide; plugin-shipped agents may not declare hooks/mcpServers/permissionMode.
- **Known weaknesses worth learning from**: flat namespace — two marketplaces can define the same plugin name and *the first registered silently wins* (bug #44042: `marketplace add` silently overwrites same-named marketplaces); no precedence mechanism between official and internal marketplaces; private distribution access control "falls back to whatever the git host already enforces."

### 1e. Discovery at scale

- **SkillsMP** (skillsmp.com, independent single-person project, unaffiliated with Anthropic/OpenAI) claims to index **1.6M–2M+ public SKILL.md files** scraped from GitHub, searchable by keyword, 800+ occupations, category, creator, with a public API. It does **no vetting or quality ranking** — "Always review code before installation." *(Extracted from skillsmp.com/about + smartscope.blog review; not adversarially verified.)*
- **Tension to note honestly:** an arXiv crawl measured skillsmp.com at **73,193 skills from 10,373 repos** (and skills.rest at 25,187) — order 10⁵, not 10⁶. The "millions" figure is the directory's own claim over raw indexed files; independent measurement found ~100k-scale distinct skills. Treat "millions" as unconfirmed marketing-adjacent.
- **The three-layer quality framework the prompt described exists, with a twist — [SkillSieve](https://arxiv.org/pdf/2604.06550)** (arXiv, 2026): Layer 1 deterministic static analysis (regex + AST + metadata heuristics, filters ~86% of volume at zero API cost) → Layer 2 LLM semantic pass (four parallel sub-tasks) → Layer 3 a **jury of three LLMs voting independently, debating on disagreement**. So the third layer is *multi-model voting*, not the simulated-run statistical reliability the prompt hypothesized. F1 = 0.920 at **$0.006/skill**, runnable on a $440 ARM board. The nearest simulated-run artifact is the official **skill-creator** eval loop (verified, §1a) and **MLflow's** trace-plus-judge harness (blog, 2026-03-23: headless runs traced, LLM judges + rule-based side-effect judges, failing traces fed back to rewrite the skill — explicitly two layers, not three). *(SkillSieve and MLflow: extracted with quotes, not adversarially verified.)*

### 1f. Security & supply chain — the numbers are bad

*(Primary-source security studies; extracted with verbatim quotes, outside the verification budget. The advisory-only posture claim IS verified 3-0.)*

- Anthropic's official posture is **advisory**: "install only from trusted sources… thoroughly audit before use… treat like installing software." No enforced sandboxing in the guidance itself. *(Verified 3-0.)*
- **Snyk "ToxicSkills"**: of 3,984 skills on ClawHub/skills.sh, **36.82% had ≥1 security issue**, 13.4% critical; 76 confirmed-malicious via human review (91% used prompt injection); 10.9% of ClawHub skills contain hardcoded credentials; publication barrier: "a SKILL.md and a week-old GitHub account."
- **arXiv "Agent Skills in the Wild"** (98,380 skills): **84.2% of vulnerabilities live in the SKILL.md prose, only 8.5% in executable code** — vetting must read the *natural language*, not just scan scripts. A single actor produced **54.1% of confirmed-malicious skills via templated brand impersonation** (85 skills, 100% template consistency) — the empirical case for reserved naming. 73.2% of malicious skills had "shadow features" (behavior absent from their own documentation) — documentation-vs-behavior comparison is the best single heuristic.
- **Koi Security / "ClawHavoc"**: 335 coordinated malicious skills on one registry, live for weeks. **Datadog** built a PoC skill that exfiltrated `gh auth token` via curl — and found an in-the-wild equivalent; critically, **Opus 4.6 refused the malicious skill but Opus 4.7 ran a modified version undetected** — *you cannot rely on the model to catch malicious skills*. A demonstrated attack also poisoned Anthropic's own pptx skill via a bundled script, riding a "don't ask again" approval. Conditional activation (trigger after N uses / env var / date window) defeats casual pre-install reading.

---

## 2. Synthesis

### 2a. Adopt SKILL.md, or build on top?

**Both, in a specific shape: Postgres stays the system of record; SKILL.md becomes the import/export projection, not the storage format.** Reasons:

1. A Comparative Skill is **more than the portable core**. Model pin, MCP server slugs, allowed tools, params schema, schedule, event triggers — none of that is in the standard (`allowed-tools` is the closest analog and it's spec-flagged Experimental). Storing SKILL.md files as truth would mean inventing a pile of non-portable frontmatter anyway — the worst of both worlds.
2. The governance spine (attestations, tools catalog, audit, shares with recipient credentials) is **relational**. Postgres rows join to it; files don't.
3. Portability is still cheap to buy at the boundary: `skills/[id]/export` emits a spec-valid skill folder (`name`, `description`, body = system prompt + instructions; Comparative-specific wiring under the spec's sanctioned `metadata` field); `skills/import` parses one. A GP engineer's local Claude Code skill can be lifted into Comparative, and a Comparative Skill dropped into `.claude/skills/` — with the documented caveat that connector wiring doesn't travel.
4. Non-technical GP employees will never hand-write YAML. The authoring layer is Comparative's existing UI/chat ("save this as a Skill"); the format is an interchange detail they never see.

**Adopt the craft, not just the format:** add a first-class `description` field to the `skills` table with the verified writing rules (what + when, trigger keywords, front-loaded) enforced by a lint, because description quality is what makes catalog search *and* any future autonomous skill-routing work. Adopt the skill-creator pattern of should-trigger/should-not-trigger prompts as the catalog's quality bar (§4).

### 2b. Skill vs. artifact vs. connector — where the vocabulary lines sit

Non-technical users will conflate these unless the UI enforces a grammar:

| Concept | Grammar | User verb | Lives | Carries access? |
|---|---|---|---|---|
| **Connector** | *permission* — "can reach" | connect / approve | Settings → Connections | IS access (per-user OAuth + attestations) |
| **Skill** | *verb* — "do this again" | run / schedule / share | chat + Skills catalog | *references* connectors; recipient re-authorizes with own credentials |
| **App** (artifact) | *noun* — "a built thing" | open / use | `/apps/{slug}` | no (SSO-gated page; CSP-sandboxed) |

The one-line test to put in the product's own docs: **a Connector is a door key, a Skill is a recipe that names which doors it needs, an App is a finished dish.** Sharing a recipe never shares your keys — the recipient's own keys must open the same doors. This is already how `shares` works; the vocabulary should say it out loud.

### 2c. Where vetting lives in the org chart

**In between the two extremes, tiered by blast radius — automated gate for team scope, human review only for org-wide scope and write-capable Skills.** Rationale: GP is an enterprise with a real IT/security function, but a mandatory human gate on every share would kill the catalog cold-start (§10.5) — and Comparative's architecture already removes the single biggest risk class the research found: **Skills cannot bundle executable scripts** (hard rule: all capability is MCP tools, gated and audited). What remains is prose risk — and 84.2% of real-world skill vulnerabilities live in prose, so the automated gate must include an LLM-judge pass, not just regex (§4).

---

## 3. Recommended packaging model for Comparative

1. **Unit of packaging = the Skill row, versioned.** Add `skill_versions` (mirroring the shipped `app_versions` pattern: version groups, pills, plain-language revert). Publishing freezes a version; adopters always run a *pinned published version*, never the owner's live draft.
2. **No bundled executable scripts — ever, as policy, not just as a gap.** State it in the spec so nobody "adds scripts support" casually: a new capability is a new MCP tool (existing hard rule). This single decision deletes the ClawHavoc/Datadog attack class from Comparative's threat model and is the largest divergence from the open ecosystem — a justified one (the product boundary rule: own governance).
3. **Two-tier catalog, borrowing the strict/non-strict distinction:**
   - **Team tier** (author-authoritative, `strict: true` analog): publish to named teammates or a team space; author's definition is truth; automated vetting gate only.
   - **Org tier** (operator-authoritative, `strict: false` analog): admin-curated catalog; curators may edit metadata, rename, re-categorize, or pin a specific version — their entry is authoritative, exactly as marketplace operators curate in the open ecosystem.
4. **Namespacing + reserved names from day one** (the open ecosystem's flat-namespace collisions and 54.1%-brand-impersonation stat are the warning): every Skill is `owner-or-team/skill-name`; reserve `gp/`, `official/`, `it/`, `admin/`, `comparative/` prefixes for the org tier; block lookalikes; re-check reservations at load, not just at publish (copying Claude Code v2.1.205's fix).
5. **Interchange:** `export` emits a spec-valid SKILL.md folder (portable core + `metadata:` block for Comparative wiring); `import` accepts one, mapping `description` → routing field, params → `arguments` extension, and surfacing unmappable fields to the user instead of silently dropping them.
6. **Discovery sized to GP, not to millions:** at dozens-to-hundreds of Skills, do **not** build search infrastructure — build *trust* infrastructure. Catalog = browse by category + free-text search over name/description + three social signals the research shows matter more than ranking at this scale: "used by your team," run counts, and last-updated recency (the pre-install checklist sources rate >6-month-stale skills as questionable). SkillsMP's lesson is what *not* to build: an unranked map of everything with a "review before install" disclaimer.

---

## 4. Publish / discover / update flow — worked user story

**Maria, a supply-chain analyst (non-technical), has a "Weekly Vendor Status" Skill** she built in chat (it reads her email + Notion via connectors and drafts a status doc).

1. **Publish.** In the Skill's page she clicks **Share → Publish to my team**. Comparative shows a plain-language manifest — *"This Skill uses: Gmail (read), Notion (read). It runs on a schedule you set. Recipients will connect their own accounts."* — and asks for a one-sentence description if hers fails the description lint (what + when + trigger words).
2. **Automated vetting gate (seconds, self-service).** Three checks, SkillSieve-shaped but scoped to Comparative's threat model:
   - *Deterministic:* no-secrets scan (reuse the shipped Apps scanner), no raw URLs/emails as exfil targets in the prompt, tool references resolve to enabled `tools_catalog` rows, description lint.
   - *LLM-judge:* prompt read for injection patterns, hidden instructions, scope mismatch between description and body (the "shadow features" heuristic — documentation-vs-behavior is the best single check per the arXiv study).
   - *Trigger eval (async, advisory):* skill-creator-style should/shouldn't-trigger probes score the description; a low score flags "hard to discover," doesn't block.
   Pass → visible to her team immediately. Rows land in `audit_log`.
3. **Escalation rule.** If the Skill references any **write/admin** action-level tool, or she picks **Publish org-wide**, it enters a review queue (IT/security or a delegated "Skill curator" role — recommend curators embedded in functions, IT owning only the queue for write-capable Skills). Reviewer sees the diff-style manifest, vetting results, and provenance (author, source thread). Approval promotes it to the org catalog under a curated namespace (`gp/…`); curators may rename/re-describe (operator-authoritative tier).
4. **Discover.** Teammate Dev opens **Skills → Catalog**, filtered to *his team* by default: categories, search, "recently used by your team," run counts, freshness. He clicks *Weekly Vendor Status*; Comparative shows the manifest and — because he hasn't connected Notion — a one-click connector setup with the standard attestation prompt. **His credentials, his attestations**; if his Notion attestation is read-only, that's what the Skill gets.
5. **Update.** Maria improves the prompt and publishes **v2** with a note. Dev, pinned to v1, gets a **notification** (existing `notifications` table): *"Weekly Vendor Status has a v2: 'handles vendors with no open POs.'"* One click diffs the prompt and updates his pin. **Recommendation: notified manual-update by default; auto-update only for org-tier curated Skills** (curators accept the responsibility the pin was protecting against — and every version bump of a write-capable Skill re-enters review). Never silent auto-update of team-tier Skills: a prompt edit can repurpose a Skill as thoroughly as a code change, and adopters ran *what they read*.

---

## 5. Security & vetting recommendation

1. **Keep the no-scripts rule absolute** (§3.2). It converts the ecosystem's worst problem (credential-stealing bundled code; model-level detection proven unreliable across model versions) into a non-problem.
2. **Vet prose with LLM + rules, gate by blast radius** (§4.2–4.3). Read-only team Skills: automated gate only. Write/admin tools or org-wide visibility: human review. This matches where real risk concentrates and keeps self-service viable.
3. **The share boundary is already right — keep it load-bearing.** Recipient-credential execution + per-recipient attestations mean a shared Skill can never *grant* access, only request it. Say this in the UI at share time and install time.
4. **Provenance + freshness surfaced everywhere** a Skill appears: author, team, version, last-updated, run count, review status. Impersonation and staleness were the two dominant real-world abuse/decay patterns.
5. **Version-bump re-review for write-capable Skills** — the pptx-skill attack rode an *update* into an existing approval. An approved Skill's next version is a new trust decision.
6. **Adopt `import` as the untrusted boundary:** anything arriving via SKILL.md import gets the full vetting gate regardless of scope, because it may have been authored outside Comparative's no-scripts world (imported `scripts/` are rejected outright, with a message explaining the MCP rule).

---

## 6. Open questions / risks

1. **How much autonomous invocation does Comparative want?** The open ecosystem's description-matching model assumes many skills mounted per session; Comparative today runs one Skill per run. If J2 chat ever auto-selects Skills, description quality becomes routing-critical — the lint and trigger-eval (§4.2) are cheap to build now and are prerequisites for that future.
2. **Copilot/Gemini portability is under-verified.** Copilot CLI reading `.claude/skills/` rests on one blog (2026-04-08); Gemini/Cursor/Windsurf adoption on secondary claims. If the export bridge (§3.5) is prioritized, spike-verify against the actual tools GP licenses before promising "works in your local editor."
3. **Marketplace-scale numbers are contested** (SkillsMP's 2M+ vs. independently measured ~100k). Doesn't change the design (Comparative is at 10²), but don't cite "millions" in internal decks without the caveat.
4. **Curator capacity.** The org tier assumes someone curates. If no function volunteers, the fallback is IT-only review — which will bottleneck exactly like the cold-start problem the catalog is meant to solve. Decide the owner before building the queue.
5. **Params schema ↔ `arguments` mapping** (also flagged by the research run): Comparative's params schema is richer than the standard's `arguments` extension; the export bridge needs a defined lossy-mapping policy.
6. **The `metadata` escape hatch drifts.** Everything Comparative-specific rides in `metadata:` on export; without a versioned schema for that block, round-tripping will silently rot. Version it from the first release.
7. **This spec could not be committed to a git branch** — this working folder is not a repository (it holds the self-contained brief, not `ai-workspace`). Move this file to `docs/specs/` in the repo and commit to `research/skills-extensibility-architecture` there.

---

## 7. Sources (with dates and verification status)

**Verified 3-0 in adversarial panels (primary):**
- Agent Skills specification — https://agentskills.io/specification (retrieved 2026-07-12; the former `anthropics/skills/spec` path now redirects here)
- Claude Code skills/slash-commands docs — https://code.claude.com/docs/en/slash-commands (retrieved 2026-07-12)
- Anthropic Engineering, *Equipping agents for the real world with Agent Skills* — https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills (2025-10-16; updated 2025-12-18 noting open-standard release)
- anthropics/skills repository incl. `.claude-plugin/marketplace.json` — https://github.com/anthropics/skills (retrieved 2026-07-12)
- agentskills/agentskills standard repo — https://github.com/agentskills/agentskills (retrieved 2026-07-12)
- OpenAI Codex skills docs — https://developers.openai.com/codex/skills (retrieved 2026-07-12; 308-redirects to learn.chatgpt.com/docs/build-skills)

**Primary, extracted with verbatim quotes, not adversarially verified (verification budget):**
- Claude Code plugins reference — https://code.claude.com/docs/en/plugins-reference (retrieved 2026-07-12) — plugin bundle contents; `strict` field; plugin-shipped-agent restrictions
- Claude Code plugin marketplaces — https://code.claude.com/docs/en/plugin-marketplaces (retrieved 2026-07-12) — marketplace.json schema; reserved names + load-time re-check (v2.1.205); `strictKnownMarketplaces`; version resolution
- Claude platform Agent Skills overview — https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview (retrieved 2026-07-12) — reserved words in `name`; audit-before-use guidance
- Snyk, *ToxicSkills* — https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub/ (2026) — 36.82%/13.4% figures; mcp-scan
- Datadog Security Labs, *Malicious skills: supply chain risks in coding agents* — https://securitylabs.datadoghq.com/articles/malicious-skills-supply-chain-risks-in-coding-agents-with-dynamic-context/ (2026) — Clawsights PoC + in-the-wild; Opus 4.6 vs 4.7 inconsistency; `disableSkillShellExecution`
- arXiv, *Agent Skills in the Wild* (98,380-skill study) — https://arxiv.org/html/2602.06547v1 (2026) — 84.2%-in-prose; 54.1% brand impersonation; shadow features
- arXiv, *SkillSieve* (three-layer vetting pipeline) — https://arxiv.org/pdf/2604.06550 (2026) — F1 0.920 at $0.006/skill; ClawHavoc/Koi figures
- skillsmp.com/about (retrieved 2026-07-12) — 2M+ index claim; no-vetting stance

**Blogs / secondary (context only):**
- allaboutken.com, Claude↔Copilot skills mini-guide (2026-04-08) — Copilot CLI directory list — *sole source for Copilot conventions*
- codex.danielvaughan.com, Codex CLI skills ecosystem (2026-03-27, updated 2026-07-12)
- MLflow blog, *Evaluating skills with MLflow* (2026-03-23) — trace + two-judge harness, closed-loop refinement
- smartscope.blog SkillsMP review (2026) — 1.6M figure; pre-install checklist
- leehanchung.github.io Claude skills deep-dive (2025-10-26); hidekazu-konishi.com plugins guide; claudefa.st plugins-distribution; GitHub issues anthropics/claude-code #19141, #26251, #44042
