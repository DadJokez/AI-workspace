# ADR 0002 — Skill format: database rows at runtime, SKILL.md for portability

- **Status:** Accepted
- **Date:** 2026-06-12
- **Deciders:** Rob (PM), Claude (PO/lead dev)
- **Related:** [specs/002-skills-spine](../../specs/002-skills-spine/), `apps/web/lib/skills.ts`, `apps/web/lib/starter-skills.ts`

## Context

Skills are AI Hub's user-facing primitive (saved, shareable, schedulable agent
definitions). We need a canonical structure that works for the pilot **and** at
100k users. The major tools each do it differently:

- **Anthropic Agent Skills** — a `SKILL.md` file: YAML frontmatter (`name`,
  `description` required; optional metadata/model) + a Markdown body of
  instructions. Progressive disclosure: only the frontmatter loads by default;
  the body loads when relevant. File-based, lives in a folder, can bundle
  resources. ([format spec](https://github.com/anthropics/skills))
- **Cursor rules** — `.cursor/rules/*.mdc`: frontmatter (`description`, `globs`,
  `alwaysApply`) + Markdown body. Also file-based, repo-scoped.
- **ChatGPT Custom GPTs** — no file format: a config object (name, instructions,
  conversation starters, knowledge files, actions) stored as JSON, edited
  through a form.

**Observation:** the file-based formats (Anthropic, Cursor) are built for a
*single developer in a repo*. They're excellent for portability and
git-versioning, but they have no native answer for multi-tenant **sharing,
RBAC, audit, search, or per-user scoping** — exactly what a 100k-user enterprise
platform needs. ChatGPT's JSON-config-in-a-database is the multi-tenant shape,
but it's proprietary and not portable.

AI Hub already stores skills as **structured database rows**
(`skills`: slug, name, description, system_prompt, model_id, mcp_providers,
visibility, provenance) — the multi-tenant shape, with sharing
(`shares`), scheduling (`schedules`), audit, and the run ledger already built
around them.

## Decision

**The database row is the runtime source of truth. `SKILL.md` (YAML frontmatter
+ Markdown body) is the portable interchange and authoring format.**

- **At runtime / for sharing / scheduling / RBAC / search:** skills are rows.
  This is what scales to 100k users and is already built.
- **For authoring, import, export, and git-versioning:** a skill maps
  losslessly to/from a `SKILL.md` file, using the **Anthropic convention** so we
  inherit its ecosystem (the public skills repo, skill-creator, others' skills
  become importable; ours become shareable as a file or checked into a repo).

**Frontmatter ↔ column mapping:**

```yaml
---
name: weekly-status            # → skills.slug (and a humanized skills.name)
description: Drafts a weekly…   # → skills.description
model: sonnet-4-6              # → skills.model_id   (AI Hub extension)
mcp_providers: [github]        # → skills.mcp_providers (AI Hub extension)
---
<everything below the frontmatter> # → skills.system_prompt
```

`name`/`description` are the Anthropic-required fields; `model` and
`mcp_providers` are our additive extensions (ignored by a vanilla Anthropic
runtime, honored by ours). The Markdown body is the system prompt.

This is **not** a file-system at runtime — we do not store or execute loose
files. We parse a pasted/uploaded `SKILL.md` into a row on import, and render a
row back to `SKILL.md` on export.

## Consequences

**Positive**
- Scales like a database (the thing we need at 100k), ports like a file (the
  thing developers and the ecosystem expect).
- Compatible with Anthropic Agent Skills — import community/Anthropic skills;
  export ours for git versioning or sharing outside AI Hub.
- The authoring format is human-writable and diffable; the **skill-creator
  skill** (seeded) can emit a valid `SKILL.md` the user saves with one click.
- No migration: rows are already the source of truth; this adds parse/serialize.

**Negative / mitigations**
- Two representations to keep in sync → mitigated by a single
  `lib/skill-format.ts` (parse + serialize, both tested) as the only converter.
- Our `model`/`mcp_providers` extensions aren't in the Anthropic spec → they're
  additive frontmatter keys; importing into a vanilla runtime simply ignores
  them, and we validate them on our side.
- Anthropic skills can bundle resource files / scripts (progressive disclosure
  beyond the body) → out of scope for v1; we import the frontmatter + body and
  note dropped resources. Revisit if real skills need bundled resources.

## Alternatives considered

- **Pure file-based (adopt Anthropic/Cursor wholesale).** Rejected as the
  runtime model: no native multi-tenant sharing/RBAC/audit/search; doesn't scale
  to 100k users without rebuilding all of that on top of a filesystem.
- **Pure DB, no portable format.** Rejected: locks skills inside AI Hub, blocks
  git-versioning and ecosystem import/export, and makes authoring a form-only
  experience.
- **Invent our own frontmatter schema.** Rejected: gratuitous incompatibility
  with the Anthropic ecosystem for no benefit; we extend their convention
  instead.

## Revisit when

A real skill needs bundled resource files or scripts (progressive disclosure
beyond a single body), or the Anthropic spec adds fields we want to honor.
