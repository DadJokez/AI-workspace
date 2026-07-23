# Deployment & Publishing Architecture for Comparative (AI Hub)

**Status:** Research spec with the Comparative publish tier implemented in #411. Service-backed publication and independent application deployment remain deferred to #133; org-wide audiences remain deferred to the organization/identity substrate (#491/#78).
**Research method:** deep-research harness — 5 search angles, 16 sources fetched, 80 claims extracted. The automated adversarial-verification phase failed on session rate limits (all 25 panels errored, 0 votes cast), so the **load-bearing claims were hand-re-verified against their primary sources on 2026-07-17** (marked *verified against primary source*); remaining claims are cited as *extracted, not adversarially verified*, each carrying a verbatim quote from its source. All URLs live as of 2026-07-14 (workflow fetch) / 2026-07-17 (manual verification).
**Date:** 2026-07-17

---

## Implementation checkpoint (2026-07-23)

Comparative's in-shell publish tier now provides:

- Snapshot-by-default publication and explicit live-via-viewer publication for artifacts with supported data bindings.
- Per-version `app-publication.v1` metadata: data mode, publish timestamp, publisher, named/private audience at publish time, and connector manifest keyed to `tools_catalog`.
- Truthful viewer chrome naming Comparative, the author, and either the snapshot timestamp or viewer-scoped live mode.
- Runtime enforcement of the selected mode. Snapshot pages cannot invoke retained artifact bindings; live pages execute only through the viewer's connection and stop serving live data when an administrator disables a manifest tool.
- URL-stable unpublish and republish, publication lifecycle audit entries, baked-data sharing warnings, and an admin publication registry with an immediate unpublish control.
- Compatibility inference for pages published before the metadata contract: binding-bearing pages remain live-via-viewer; other pages remain snapshots.

The internal API and database status still use the historical `deploy`/`deployed` vocabulary for compatibility. Product surfaces use **Publish**. No public-link audience, org-wide audience, service-principal credentials, independent hosting, or custom domains are introduced by this slice.

---

## 0. Grounding: what Comparative already has

- **A thin "publish" tier is already shipped (J4 slice):** chat-built HTML artifacts (`workspace_artifacts`) promote one-click into an `apps` registry served **in-shell** at `/apps/{slug}` — SSO-gated, restrictive CSP, version groups with plain-language revert, and a no-secrets scan at deploy time. API surface: `apps/[id]/deploy`, `.../versions`, `.../content`; artifacts also support raw `download`.
- **Nothing leaves the harness yet.** Apps are served by the same Next.js shell on ECS/Fargate. There is no independent URL, no custom domain, no per-app infrastructure. The full platform — git/pipeline substrate, per-app AWS services, deploy controller, workspace-as-IdP SSO for independently hosted apps — is explicitly not yet built (#133).
- **Sharing is credential-honest:** named Skill/App shares (`shares`) execute with the **recipient's** credentials, owner-revocable. This precedent turns out to be exactly the model the wider ecosystem converged on for live-data artifacts (§2).
- **Live data is per-user and per-turn:** MCP tokens live in `oauth_tokens` (AES-256-GCM), minted short-lived and mounted per turn. An app's "live" data path exists only inside a chat turn today — never inside the served page.
- **Governance hooks already sit at the boundary:** audit ledger on every tool call, admin `tools_catalog` + per-user attestations, no-secrets scan on app deploy. Publish-time governance extends these; it does not start fresh.
- **Product boundary rule applies directly:** *do not rebuild a hosting platform unless AI Hub needs that layer for control, audit, governance, UX, or portability.* This spec's central judgment call is where that line falls.

---

## 1. Publish vs. deploy, defined for Comparative

The research confirms the two patterns are genuinely different products, not two sizes of the same feature. A third-party comparison states it cleanly: "A deploy ships a project: a directory of files, often with a build step, tracked as a site you maintain over time with previews, rollbacks, and a dashboard. A publish ships a finished file: the agent calls one tool, you get one URL, done." *(stacktr.ee/deploy-html-from-claude-code, 2026; extracted, not adversarially verified.)*

### 1a. The publish end: Claude's native artifact mechanism (the reference point)

*(All claims in this subsection verified against primary sources 2026-07-17: support.claude.com articles 9547008 and 9487310; code.claude.com/docs/en/artifacts; support.claude.com article 14729249.)*

- **One action, no repo, no build.** claude.ai: open artifact → **Publish** → "Anyone with the link can view and interact with it." Claude Code: Claude writes one HTML/Markdown file and publishes it; republishing goes **to the same stable URL**, each publish becomes a version with a viewer-side version picker.
- **URL-as-access-control on consumer plans; org-audience on enterprise plans.** Artifacts start private to the author. Team/Enterprise: share to specific people or the whole org; viewers sign in to claude.ai; **public sharing is off until an Owner enables it**, and "Artifacts created on Team or Enterprise accounts can only be shared within your organization—they cannot be published publicly" (consumer-side artifacts). No password gate or email-domain gate exists at any tier — third-party wrapper services (Stacktree, VibeDeploy, ShareDuo) exist precisely to add passwords, domain gates, analytics, and custom domains on top.
- **Hard limits, documented:** Anthropic domain only (viewer loads from a sandboxed `*.claudeusercontent.com` origin), no custom domain, no analytics, "Created with Claude" header, no expiry control; unpublishing is irreversible — "Once you unpublish an artifact, you cannot publish that same artifact again" (republish mints a new URL). Single self-contained page ≤ 16 MiB, no backend, no relative links; a strict CSP "blocks scripts, stylesheets, fonts, and images loaded from any other host, along with fetch, XHR, and WebSocket calls."
- **The finding that matters most for Comparative:** artifact publishing **requires Anthropic API auth via a claude.ai login and is explicitly "Not available on Amazon Bedrock, Google Cloud's Agent Platform, or Microsoft Foundry."** Comparative runs Bedrock/AgentCore. The native publish mechanism is therefore *not merely limited for Comparative's purposes — it is unavailable in Comparative's runtime*. Comparative's own publish tier (`/apps/{slug}`) isn't a nice-to-have duplicate; it is the only publish path GP can have.

### 1b. The deploy end: git-push hosts, now heavily agent-drivable

- **Vercel** operates an official remote MCP server at `https://mcp.vercel.com` (OAuth; manage projects/deployments, analyze deployment logs). One command wires it into Claude Code (`claude mcp add --transport http vercel https://mcp.vercel.com`). Vercel restricts connections to a reviewed allowlist of AI clients, warns that connecting "grants the AI system … the same access as your Vercel user account," and recommends human confirmation on every step. *(vercel.com/docs/agent-resources/vercel-mcp, last updated 2026-06-26; verified against primary source.)*
- **Netlify** ships an MCP server exposing the Netlify API/CLI to agents — create projects, deploy from a prompt, set env vars and secrets, read deploy logs — plus **Agent Runners**: hosted Claude Code/Codex/Gemini runs launched from the Netlify dashboard, on a new branch off production, inheriting previews/rollbacks/build settings; env-var fixes can be redeployed without re-running the agent. GitHub-only today; usage metered on credit plans. *(netlify.com blog + docs.netlify.com/build/build-with-ai/agent-runners, last updated 2026-06-16; extracted, not adversarially verified.)*
- **Cloudflare** publishes an official Claude Code plugin (`/plugin marketplace add cloudflare/skills`) bundling MCP servers and a wrangler Skill (`npx wrangler deploy`, D1 migrations), and a "Code Mode" MCP compressing 2,500+ API endpoints into ~1,000 tokens. First tool call still requires a human OAuth authorization. *(developers.cloudflare.com/agent-setup/claude-code, 2026-04-27; extracted, not adversarially verified.)*
- **Net:** essentially the whole deploy pipeline — create project, configure env, deploy, read logs, roll back — is agent-drivable via MCP/CLI today. The two residual human steps are (1) initial OAuth/credential grant at the host and (2) confirmation on side-effectful actions, which every vendor recommends keeping.

### 1c. Definition for Comparative

| | **Publish** | **Deploy** |
|---|---|---|
| Unit | one finished self-contained page | a project directory with a build |
| Action | one click, instant URL | pipeline: build → preview → promote |
| Lifecycle | versions of one page; revert | branches, previews, rollbacks, maintenance |
| Access | audience grant (SSO) or link | host-level auth, custom domains |
| Comparative today | ✅ `/apps/{slug}` slice | ❌ #133, not built |
| Right for | reports, dashboards, one-off tools | living internal applications |

---

## 2. The live-data problem and Comparative's answer to it

### 2a. The problem, confirmed

The central claim from the original artifact research **holds, with a sharper mechanism than "it breaks":**

- **The connection was never in the artifact.** "The MCP connection is between your Claude account and the third-party service. The deployed copy doesn't have that connection." An exported live artifact's "HTML skeleton can be exported, but the live data connections won't function outside of Claude's MCP environment." Viewers of a naively shared live artifact "see placeholders." *(instapods.com, shareduo.com, 2026; extracted, not adversarially verified — but consistent with all primary sources below.)*
- **Anthropic's own products confirm the scoping by design.** Cowork live artifacts: "Shared artifacts use the viewer's access, not yours… If they don't have access to an underlying data source, that part of the artifact shows an error instead of your data." *(support.claude.com article 14729249; verified against primary source.)*

### 2b. The ecosystem's three workarounds — and which one won

1. **Bake a static snapshot at publish time.** The CSP default: Claude inlines all data; "on earlier versions, Claude publishes the page with whatever data the session gathered while building it." Honest, cheap, stale.
2. **Re-establish the connection at the destination with the *viewer's* credentials.** This is what Anthropic converged on for both Cowork live artifacts and (as of Claude Code v2.1.209) published artifacts: the page declares which connectors it may call, claude.ai makes the calls server-side through **the viewing account's own connections**, each viewer approves first, missing connections render a fallback instead of data, and **connector-backed artifacts cannot be shared to a public link on any plan**. *(code.claude.com/docs/en/artifacts; verified against primary source 2026-07-17.)*
3. **Point the published copy at a separately hosted backend with its own credentials.** The full-deploy answer: a real service with service-principal creds. Maximum power, maximum ops burden — and the only pattern of the three that can serve viewers who have no relationship with the data source at all.

The decisive observation: **workaround 2 is exactly Comparative's existing `shares` model** (recipients run Skills/Apps with their own credentials). Comparative independently built the pattern the ecosystem converged on. The live-data answer is therefore not new machinery — it is extending an existing, shipped invariant from Skill execution to page viewing.

### 2c. Comparative's answer (recommendation)

Every published Comparative app declares one of three explicit data modes, shown to viewers as a badge:

- **Snapshot (default).** Data inlined at publish time; banner reads "Data as of {timestamp} — rebuild to refresh." No claim of liveness, ever. Republishing = new snapshot version in the existing version-group machinery.
- **Live-via-viewer.** The app carries a **connector-dependency manifest** (which MCP servers/tools it may call — the analog of Claude's publish-time connector declaration). At view time, data calls route through the shell using the *viewer's* `oauth_tokens`, gated by the *viewer's* attestations and the admin tools catalog, with one `audit_log` row per call — the same spine as a chat turn. Viewer lacks a connection → that section renders a "connect X to see this" fallback, mirroring Cowork's behavior. Apps in this mode are **never shareable outside the SSO boundary**, mirroring Anthropic's "connector-backed artifacts can't have a public link" rule.
- **Service-backed (deploy tier only, #133).** A maintained app with its own backend and admin-approved service-principal credentials. This is the only mode that can show one canonical dataset to viewers who individually lack source access — and precisely because of that, it requires explicit admin sign-off (a human-owned change per §11 of the overview: new credentials, new standing access).

**The honesty rule (per the prompt's Step 2, decided explicitly):** Comparative-published things must never *claim* to be live unless they are live-via-viewer or service-backed at that moment. Snapshot is the honest default; "publish the dashboard" and "keep it live" can coexist, but only under the viewer-credential model — and that model deliberately shows different viewers different data, which is a feature (least privilege), not a bug, and must be stated in the UI.

---

## 3. Recommended default flow for GP users (worked story)

**Priya, an FP&A analyst at GP, builds a spend dashboard in chat against the Databricks connector.**

1. **Build:** the artifact renders in-thread (exists today, `workspace_artifacts`).
2. **Publish:** she clicks **Publish** on the artifact. One dialog, three fields:
   - *Data:* Snapshot (preselected) / Live-via-viewer (offered because the build used MCP data; shows the connector manifest it would declare).
   - *Audience:* Just me → Named people (the existing `shares` flow) → Everyone at GP (link works for any SSO'd employee).
   - The no-secrets scan runs (exists today); a connector manifest is recorded if she chose live.
3. **Send:** she gets `https://…/apps/gp-spend-dashboard` and drops it in a Teams channel. A colleague clicks it, passes SSO, and sees either the timestamped snapshot or — if Priya chose live-via-viewer and the colleague has attested Databricks access — current data under the colleague's own entitlements. No harness, no thread, no Comparative UI beyond the page itself.
4. **Refresh:** "rebuild with this month's data" back in chat republishes to the same slug as v2; the version pills and revert already exist.
5. **Graduation, only if needed:** six months later the dashboard has become a team fixture needing scheduled refresh, custom filters, and a real backend. *That* is the deploy-tier trigger (#133): promote the app to a maintained project — git substrate, per-app service, service-backed data mode, deploy controller. The user-visible distinction is a lifecycle badge: **Published page** vs. **Maintained app** (with an owner on the hook).

**Default model, stated plainly:** Comparative's default is **publish** — the in-shell one-click path, because Comparative's outputs are dominantly reports/dashboards/small tools and because the native Claude publish path is unavailable on Bedrock anyway (§1a). **Deploy** is the exception, gated on a single question: *does this thing need to keep evolving with an owner after it ships?* Both are needed eventually; only publish is needed now. Building #133's full pipeline before publish-with-live-data ships would be sequencing backwards.

---

## 4. Domain / branding recommendation

- **Internal subdomain, yes; public custom domains, no.** GP's need is "droppable into a Teams channel or intranet page," which an SSO-gated internal hostname fully serves. Recommend promoting apps from the `/apps/{slug}` path to a dedicated internal hostname (e.g. `apps.aihub.gp.com/{slug}`) when #133 lands — Route 53 + ACM + ALB are already in place, so this is DNS + cert work, not platform work. A distinct hostname also gives apps a cleaner CSP/cookie boundary than living under the shell's origin.
- **Do not build public custom-domain support.** Every external host gives custom domains away free at the deploy tier (Cloudflare Pages: 100 custom domains/project on the free plan; Vercel/Netlify similar — *extracted, not adversarially verified*), so if a GP output ever genuinely needs a public domain, the right move under the product-boundary rule is exporting the project to a real host, not rebuilding Vercel. For cost calibration only: paid tiers run ~$5/mo (Cloudflare Workers Paid) to ~$19–20/mo (Netlify Pro flat / Vercel Pro per-seat) *(devtoolreviews.com, blog.vibecoder.me, 2026 comparisons; extracted, not adversarially verified)*.
- **Branding:** the published page header should carry GP/AI Hub identity and the author's name (Claude Code's artifact header naming the author is the right precedent), plus the data-mode badge from §2c.

### 4a. Failure modes to design around at the deploy tier (from 1c research)

Documented reasons agent-generated deploys fail or need rework — relevant the moment #133 builds a pipeline:

- **Env vars/secrets not set before first deploy** — the #1 practitioner-reported runtime failure ("build and deploy succeed, app crashes on a nonexistent API key"); agent-generated code also hardcodes secrets. *(lowcloud.io, northflank.com, 2026; extracted — fetch of these two sources failed in the workflow, claims come from search-result snippets.)* Comparative mitigation: the deploy controller must refuse a first deploy while declared env vars are unset, and the existing no-secrets scan must run on app source at every version.
- **Lockfile/dependency drift between build environments** — package-version mismatch between local and CI is repeatedly named the leading cause of build failure; Vercel derives its build cache key from package manager + Node version, so uncommitted lockfiles produce non-deterministic builds. *(vercel.com/docs/deployments/troubleshoot-a-build, last updated 2026-06-15, verified; Netlify's equivalent page has since been rewritten around AI diagnosis (checked 2026-07-17), so the "leading cause" phrasing is extracted-only.)* Mitigation: the agent commits lockfiles, always; the pipeline pins the package manager.
- **Stack auto-detection mismatches** — framework presets misfire on generated stacks (Netlify "occasionally misconfigures projects"; Next.js on Cloudflare Pages needs the `@opennextjs/cloudflare` adapter); builds also die on platform limits (45-min Vercel / 20-min Cloudflare timeouts, 8 GB memory). *(blog.vibecoder.me, developers.cloudflare.com/pages/platform/limits; extracted, not adversarially verified.)* Mitigation: Comparative's deploy tier should support a deliberately small allowlist of stacks it builds (start: static + one SSR framework), not general auto-detection.

---

## 5. Governance at publish time

Publishing is the moment a thing escapes its thread. Recommended gates, layered on the existing spine:

1. **"Anyone with the link, inside the org" is an acceptable default for snapshot apps** — it is strictly safer than today's shipped behavior implies, because the link is SSO-gated and the content is static data the author already had. Precedent: Claude Code artifacts default private with org-audience sharing; Anthropic requires an *Owner* to enable anything public. Comparative should have **no public tier at all** in v1.
2. **Live-via-viewer apps need no new approval flow** — the viewer's own attestations and the tools catalog already gate every data call, per viewer, at view time. The connector manifest is recorded at publish and enforced at runtime (the page cannot call outside its declaration — Anthropic's declaration model, verified).
3. **Three events land in `audit_log`:** publish (with data mode + manifest + audience), share-grant/revoke, unpublish. Precedent: Anthropic logs `claude_artifact_*` events to the org audit log and exposes a Compliance API to list/fetch/delete artifacts; Comparative's admin surface should match (list all published apps, view manifest, kill link). Add retention policy knobs (Anthropic ships separate retention for private vs. shared artifacts).
4. **Human review is reserved for two escalations:** (a) service-backed data mode — new standing credentials, admin sign-off, consistent with the "human-owned changes" rule; (b) org-wide *catalog* placement (J5, #78) — publishing to everyone-with-link is self-serve, being *promoted/discoverable* is curated. This mirrors the skills-spec's marketplace `strict:false` curation stance and keeps runtime governance (prompt #5) as the enforcement layer rather than a publish-time bottleneck.
5. **Unpublish must be reversible and URL-stable.** Anthropic's one-way unpublish (republish = new URL, storage data deleted) is a documented pain point users route around with third-party hosts. Comparative controls its own registry: unpublish should mean "link returns 404/revoked-notice, content and slug retained, republishable" — matching how share-revoke and version-revert already behave.

---

## 6. Open questions / risks

1. **Viewer-credential UX cost.** Live-via-viewer means a viewer without a Databricks attestation sees fallbacks, and two viewers can see different numbers. For exec-facing dashboards that may be unacceptable — the pressure will be toward service-backed mode; decide early how much of that pressure to absorb (each service-backed app is standing credentials to govern).
2. **View-time MCP calls are a new load profile.** Today MCP mounts per chat turn; live-via-viewer makes page-loads trigger tool calls (with browser-side caching, per Anthropic's model). Token-lifetime work (§10.2 of the overview) and rate limits must precede it.
3. **The connector manifest needs a schema** — which server slugs, which tools, read-only enforcement? Natural join point with prompt #3's connector-governance model; recommend manifests reference `tools_catalog` keys so catalog disablement instantly propagates to published pages.
4. **Prompt-injection at view time:** a live page rendering third-party data (e.g., Notion text) inside the org is an injection surface if page content ever feeds back into agent context (e.g., "iterate on this app"). The nonce-framing pattern (`lib/artifact-context.ts`) must wrap app-embedded data on re-ingestion.
5. **When does in-shell serving actually break?** The deploy tier's real trigger might be operational (an app needing its own compute/DB) rather than lifecycle. #133's "workspace-as-IdP SSO for independently hosted apps" is the expensive part — worth deferring until ≥1 concrete app demands it.
6. **Research caveat:** the automated 3-vote adversarial verification never ran (infrastructure failure). The §1a/§2 crux claims were hand-verified against primary sources on 2026-07-17; pricing, practitioner-failure-mode, and third-party-host claims were not independently re-verified and should be re-checked before any of §4a hardens into implementation tickets.

---

## 7. Sources with dates

**Primary (hand-verified 2026-07-17):**
- [Share session output as artifacts — Claude Code docs](https://code.claude.com/docs/en/artifacts) — CSP/page constraints, stable-URL versioning, audience model, viewer-scoped connector calls (v2.1.209+), no-public-link rule for connector-backed artifacts, **Bedrock/Vertex/Foundry unavailability**, org admin controls, `claude_artifact_*` audit events, Compliance API, retention.
- [Publish and share artifacts — Claude Help Center (art. 9547008)](https://support.claude.com/en/articles/9547008-publish-and-share-artifacts) — one-action public publish, irreversible unpublish, Team/Enterprise org-only sharing.
- [What are artifacts — Claude Help Center (art. 9487310)](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) — per-viewer MCP authentication, 20 MB artifact storage, publish flow. *(Workflow-extracted with quotes; not re-fetched manually.)*
- [Use live artifacts in Claude Cowork — Claude Help Center (art. 14729249)](https://support.claude.com/en/articles/14729249-use-live-artifacts-in-claude-cowork) — viewer's-access sharing model, per-source error fallback, local-not-remote storage.
- [Use Vercel's MCP server — Vercel docs](https://vercel.com/docs/agent-resources/vercel-mcp) (last updated 2026-06-26) — remote OAuth MCP, client allowlist, account-scope warning, human-confirmation guidance.
- [Troubleshooting Build Errors — Vercel docs](https://vercel.com/docs/deployments/troubleshoot-a-build) (last updated 2026-06-15) — build cache keyed on package manager/Node version, framework-preset dependence, build limits (45 min / 8 GB).

**Primary (workflow-extracted with verbatim quotes; not adversarially verified):**
- [Netlify MCP Server announcement — netlify.com blog](https://www.netlify.com/blog/netlify-mcp-server-ai-agents-deploy-your-code/) (announced 2025; page updated 2026) — prompt-driven deploys, env/secret configuration via MCP.
- [Agent Runners overview — docs.netlify.com](https://docs.netlify.com/build/build-with-ai/agent-runners/overview/) (last updated 2026-06-16) — hosted agent runs, branch-off-production model, GitHub-only, credit metering, redeploy-without-agent.
- [Claude Code + Cloudflare — developers.cloudflare.com](https://developers.cloudflare.com/agent-setup/claude-code/) (2026-04-27) — official plugin, wrangler Skill, Code Mode MCP, OAuth-first-call requirement.
- [Cloudflare Pages limits — developers.cloudflare.com](https://developers.cloudflare.com/pages/platform/limits/) — 100 custom domains/project free, 500 builds/month free, 20-min build timeout, 20k-file/25 MiB asset caps.
- [Fix a failed deploy — docs.netlify.com](https://docs.netlify.com/resources/troubleshooting/fix-a-failed-deploy/) (last updated 2025-07-14) — page has been rewritten around AI failure diagnosis; the earlier "leading cause of build failure" phrasing no longer appears (checked 2026-07-17).

**Secondary (blogs/comparisons, 2026; extracted, not adversarially verified):**
- [stacktr.ee/deploy-html-from-claude-code](https://stacktr.ee/deploy-html-from-claude-code) — publish-vs-deploy definition; one-command deploys compared; Netlify anonymous deploys.
- [stacktr.ee/share-claude-artifacts](https://stacktr.ee/share-claude-artifacts), [stacktr.ee/blog/claude-artifact-cannot-republish](https://stacktr.ee/blog/claude-artifact-cannot-republish) — native-publish gaps (no password/analytics/expiry; unpublish one-way).
- [instapods.com/blog/deploy-claude-artifact-as-a-real-website](https://instapods.com/blog/deploy-claude-artifact-as-a-real-website/) — "The MCP connection is between your Claude account and the third-party service"; workaround catalog; cost/effort tiers.
- [shareduo.com/blog/claude-live-artifacts](https://www.shareduo.com/blog/claude-live-artifacts), [shareduo.com/blog/claude-artifacts](https://www.shareduo.com/blog/claude-artifacts) — exported skeleton loses live connections; native-publish gap list.
- [blog.vibecoder.me/vercel-vs-netlify-vs-cloudflare-pages](https://blog.vibecoder.me/vercel-vs-netlify-vs-cloudflare-pages) — auto-detection friction per host; 2026 pricing (Vercel Pro $20/user/mo, Netlify Pro $19/mo, Cloudflare $5/mo); bandwidth-overage deltas.
- [devtoolreviews.com pricing comparison 2026](https://www.devtoolreviews.com/reviews/vercel-vs-netlify-vs-cloudflare-pages-pricing-comparison-2026), [danubedata.ro static-hosting comparison 2026](https://danubedata.ro/blog/cloudflare-pages-vs-netlify-vs-vercel-static-hosting-2026) — tier pricing corroboration. *(Fetches failed in workflow; search-snippet provenance only.)*
- [lowcloud.io vibe-coding deployment problems](https://lowcloud.io/en/blog/vibe-coding-deployment-problems), [northflank.com how-to-vibe-code-securely](https://northflank.com/blog/how-to-vibe-code-securely), [repoassistant.com vercel-deployment-failed-ai-app](https://repoassistant.com/vercel-deployment-failed-ai-app) — practitioner failure modes (env vars #1, hardcoded secrets, preset misdetection). *(Fetches failed in workflow; search-snippet provenance only.)*
- [developer.salesforce.com — Connect Claude with Salesforce Hosted MCP Servers](https://developer.salesforce.com/blogs/2026/05/connect-claude-with-salesforce-hosted-mcp-servers) (May 2026) — per-user OAuth as the origin of the Salesforce-dashboard live connection.
