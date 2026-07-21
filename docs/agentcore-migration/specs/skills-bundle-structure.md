# Spec — Skills Bundle Structure (S3) & Contribution Model

> How org-owned skills get from the `/skills` catalog into AgentCore Harness via S3, without
> abandoning the existing `SKILL.md` format or the RBAC/audit the DB provides.

## Assumptions

- The DB row stays the **system-of-record** for skills (multi-tenant, sharing, RBAC, audit, search)
  per [adr/0002-skill-format.md](../../adr/0002-skill-format.md); S3 is a **deploy artifact**.
- `SKILL.md` (YAML frontmatter + Markdown body) is already the portable format and is Anthropic-Agent-
  Skills-compatible — AgentCore skills consume the same shape.
- Harness reads skills as `HarnessSkill` objects sourced from `awsSkills | git | s3 | path`. We use
  **`s3`** for org skills, **`awsSkills`** only for the AWS-ops agent, **`git`** for eng-authored skills.

## Why not make S3 the source of truth?

Because RBAC, sharing, per-user attestation, clone lineage, and audit all live in the DB
([specs/002-skills-spine](../../../specs/002-skills-spine/spec.md)). Making S3 authoritative would
fork governance. Instead: **author in the UI → publish to S3 on promote → Harness reads S3.**

## S3 layout

```
s3://acme-comparative-skills/
  skills/
    gp/
      marketing/
        campaign-brief/
          SKILL.md
          assets/               # optional: templates, example CSVs, prompt snippets
          checksum.txt          # sha256 of SKILL.md, written at publish
        competitor-scan/
          SKILL.md
      finance/
        budget-query/
          SKILL.md
      analytics/
        qlik-summary/
          SKILL.md
      shared/                    # org-wide, admin-published only
        gp-style-guide/
          SKILL.md
  _manifests/
    gp-marketing.json           # lists skill paths + versions in the marketing bundle
    gp-finance.json
```

- **One folder per skill**, named by the skill slug; domain is the parent (`marketing`, `finance`,
  `analytics`, `shared`).
- `SKILL.md` is the rendered export of the DB row (parse-on-import / render-on-export per
  [adr/0002](../../adr/0002-skill-format.md)).
- `checksum.txt` lets the publish pipeline detect drift and lets Harness pin an exact version.
- `_manifests/*.json` group skills into named bundles a harness can reference.

## Naming conventions

- Bucket: `acme-comparative-skills` (one per environment: `-staging`, `-prod`).
- Path: `skills/org/{domain}/{skill-slug}/` — `{domain}` ∈ {marketing, finance, analytics, sales,
  ops, shared}; `{skill-slug}` = the DB skill slug (kebab-case, already unique per
  [specs/002](../../../specs/002-skills-spine/spec.md)).
- Versioning: rely on **S3 object versioning** + the `checksum.txt`; the harness `HarnessSkill` s3
  source pins a version id so a promoted harness is reproducible.

## CreateHarness reference

```jsonc
"skills": [
  { "s3": { "bucket": "acme-comparative-skills-prod", "prefix": "skills/org/marketing/" } },
  { "git": { "repository": "https://github.com/gp/comparative-skills", "revision": "<pinned-sha>" } },
  { "awsSkills": {} }            // AWS-ops agent only
]
```
> Discrepancy note: the blog writes `awsSkills: {}` as a top-level toggle; the API puts it as a
> member of the `HarnessSkill` union inside `skills[]` (as above). Confirm in console.

## Contribution model (non-engineers editing skills safely)

| Step | Who | Where | Guardrail |
|---|---|---|---|
| 1. Author / edit | business user | `/skills` UI (unchanged) | per-user RBAC; never touches S3 |
| 2. Review (optional) | domain owner / admin | `/skills` review | required for `shared/` domain |
| 3. Publish-on-promote | system | render `SKILL.md` → S3 + checksum + S3 version | no-secrets scan (reuse J4 scanner), schema validate |
| 4. Reference | engineer (once) | `CreateHarness`/`UpdateHarness` s3 prefix | pinned version id |

- **Business users never write to S3 directly.** A "Publish" action in the UI runs the render +
  no-secrets scan + S3 write. This keeps the safe authoring surface while feeding Harness.
- **No-secrets scan** reuses the existing J4 artifact scanner ([ROADMAP.md](../../ROADMAP.md) J4) so a
  skill can't leak a key into a public-ish bundle.
- **`shared/` (org-wide)** is admin-publish-only; personal/team skills publish under their domain and
  are referenced by harnesses scoped to those users (via `allowedTools` + which skill bundle the
  harness loads).
- **Promotion = the eval gate.** A skill change re-runs that capability's eval set
  ([eval-and-optimization-loop.md](eval-and-optimization-loop.md)) before the S3 publish that PROD reads.

## Open items

- Whether each saved skill becomes its own harness, or one "skill-runner" harness loads a bundle and
  the shell passes the chosen skill's `systemPrompt`/`allowedTools` per `InvokeHarness`. **Recommended:
  one skill-runner harness + per-invocation overrides** — fewer harnesses to version, skills stay data.
- Build-vs-buy for the publish pipeline (see [04-open-questions.md](../04-open-questions.md)).
