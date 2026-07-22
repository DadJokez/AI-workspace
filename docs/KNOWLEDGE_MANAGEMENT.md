# Context & Knowledge Management

> How AI Hub gives the assistant the right context — about **you**, about your
> **team**, and about the **company** — without becoming a data-governance
> liability. This is the substrate that makes every other capability feel like
> it "knows us" instead of starting cold every time.
>
> Status: strategy doc. The user layer has shipped bones (Vault); the team and
> org layers are design. Sequenced against DESKTOP_PARITY_BACKLOG.md (projects)
> and specs/005 (onboarding).

## The core idea: four context scopes, one injection point

Context lives at four scopes, narrowest to widest. Every turn assembles a
**context pack** by layering them. The user always sees and controls what's in
their own scope; wider scopes are governed by their owners.

```
┌─ ORG ─────────────────────────────────────────────┐
│  Company-wide facts, policies, glossary.          │
│  Curated by admins. Read-only to users.           │
│  ┌─ TEAM ──────────────────────────────────────┐  │
│  │  A team's shared context: how we work, our  │  │
│  │  systems, our acronyms, our docs.           │  │
│  │  Curated by team leads. Read by members.    │  │
│  │  ┌─ PROJECT ─────────────────────────────┐  │  │
│  │  │  A specific effort: goal, reference   │  │  │
│  │  │  files, instructions. (= Claude       │  │  │
│  │  │  Projects; parity item P1.2.)         │  │  │
│  │  │  ┌─ USER ──────────────────────────┐  │  │  │
│  │  │  │  Who you are, how you like       │  │  │  │
│  │  │  │  answers, what you're working    │  │  │  │
│  │  │  │  on. You own it fully.           │  │  │  │
│  │  │  └──────────────────────────────────┘  │  │  │
│  │  └────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

The assembled pack is injected the same way the agent preamble is today — it's
the natural extension of `buildAgentPreamble`, which already layers user
display name + custom instructions + Vault + connected tools.

## Layer 1 — User context (shipped bones, needs a face)

**What it is:** who you are and how you want the assistant to behave.

**Have today:** `users.custom_instructions`, the Vault memory-capture pipeline
(`memory_capture_queue` → `user_memory_items`, suggested → approved → injected),
and `users.tour_completed_at`. The preamble already injects approved Vault
markdown.

**Sources that feed it:**
- **Custom instructions** set by the user in Settings.
- **Automatic capture** during chats (already built) — "I'm in supply chain,"
  "I always want bullet points" → suggested, user-approved.
- **Manual** entry in Vault.

The first-run flow (specs/005) intentionally collects only an assistant name.
It does not guess at durable role context before the user has done real work.

**The gap:** no surface to *see and curate* the durable profile. Highest-value
next step on this layer. Principle: **the user can always read, edit, and delete
everything in their own scope.** That's both a trust feature and the GDPR/CCPA
answer.

## Layer 2 — Project context (parity P1.2)

**What it is:** a bounded effort — "Q3 capacity planning," "the Acme renewal" —
bundling persistent instructions + reference files + the threads working on it.
Directly the Claude Projects model.

**Design:**
- `projects` (id, name, instructions, owner, created_at).
- `project_members` (project_id, user_id, role) — projects are shareable.
- Threads, uploaded files (parity P1.1), and skills can belong to a project.
- Project instructions + a digest of its reference files inject into every turn
  inside the project.

**Why it matters for knowledge management:** the project is the *unit of shared
context* most teams actually think in. It's smaller than "the team" and has a
clear owner, so it sidesteps most of the governance hardness of the team layer
while delivering 80% of the "it knows what we're working on" value.

## Layer 3 — Team context (design — the hard, high-value layer)

**What it is:** the shared knowledge a team carries — how they work, the systems
they use, their acronyms, their canonical docs. The thing that makes a new hire
take three months to be useful.

**Why it's hard:** this is where knowledge management usually dies. Two failure
modes to design against:
1. **The stale wiki problem** — a "team knowledge" textarea nobody updates, so
   the assistant confidently cites last year's process.
2. **The leakage problem** — team context bleeds to people who shouldn't see it,
   or pulls in source documents with their own access controls.

**Design principles:**
- **Owned and dated.** Every team-context item has an owner and a
  `last_reviewed_at`; the assistant down-weights or flags stale items, and the
  team lead gets a periodic "review your team context" nudge. Freshness is a
  first-class property, not an afterthought.
- **Curated, not crawled (v1).** Resist auto-ingesting SharePoint/Confluence at
  first — that imports their access-control complexity and their staleness.
  Start with a small, deliberate, human-curated set ("here are the 10 things a
  new teammate must know"). Crawling is a Tier-2 decision after the curated set
  proves valuable.
- **Respects source ACLs when integrations land.** When team context *does*
  reference a live doc (via an MCP integration), the assistant fetches it with
  the **requesting user's** credentials — never a service account that bypasses
  per-user permissions. Same principle as skill sharing: context grants
  visibility, never credentials.

**Likely shape:** `teams`, `team_members`, `team_context_items` (owner,
body, source_link?, last_reviewed_at). Members read; leads curate.

## Layer 4 — Org context (design — smallest surface, set by admins)

**What it is:** company-wide ground truth — the glossary ("at GP, 'the mill'
means…"), key policies, the org's own description of itself. Small, slow-moving,
admin-owned, read-only to everyone. Mostly solves the "the assistant doesn't
know basic GP facts" cold-start. Lowest governance risk because it's curated by
admins and contains nothing user-specific.

## The flywheel (why this compounds)

This connects to the create→share→**propose** north star. As context accrues:
- The assistant gets sharper per user/team without anyone prompt-engineering.
- **Usage signal + role context → skill proposals**: "people in supply chain
  with your tools run these skills — want this one?" The role answers from
  onboarding + the team scope are exactly the signal that powers this.
- The #78 activity feed becomes the safe, aggregated view of what's working —
  which feeds back into team and org context.

## Sequencing

1. **User-context face** (Memory page, parity P1.3) + **onboarding** (specs/005)
   — ship together; immediate "it knows me" payoff, lowest risk.
2. **Projects** (parity P1.2) — the shared-context unit teams think in.
3. **Org context** — small, admin-owned, high cold-start value, low risk.
4. **Team context** — last, because it's the hardest to get right; do it only
   after projects prove the shared-context pattern and with the owned-and-dated
   discipline above. Curated before crawled.

## Non-negotiables (the IT-review answers)

- Users can read/edit/delete everything in their own scope.
- Wider scopes never inject another user's private data.
- Live documents are always fetched with the requesting user's own credentials;
  context never escalates access.
- Every scope's contents are inspectable and every injection is auditable —
  "why did the assistant know that?" must always be answerable.
