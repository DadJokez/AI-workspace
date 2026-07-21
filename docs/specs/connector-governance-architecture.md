# Connector Ecosystem & Governance for Comparative (AI Hub)

**Status:** Research spec — no implementation. Produced from prompt `03-connector-governance-research-prompt.md`, grounded against `TECHNICAL_OVERVIEW.md` (July 2026 snapshot of `ai-workspace`).
**Research method:** deep-research harness — 6 search angles, 26 sources fetched, 130 claims extracted, top 25 adversarially verified (3 independent refutation votes per claim): **22 confirmed (3–0 or 2–0), 0 refuted, 3 unverified-by-vote** (all three from `claude.com/blog/enterprise-managed-auth` and corroborated by 3–0-verified claims from the official MCP blog). Claims outside the top-25 verification budget are cited below as *extracted, not adversarially verified* — each carries a verbatim quote from its source. Source URLs were live as of **2026-07-14** (fetch date).
**Date:** 2026-07-17

**Coverage note (honesty first):** the research run returned strong primary-source coverage for four of the five requested angles. It returned **no verified claims about the browser-use and computer-control tiers** of the maturity ladder (§1 covers them from the prompt's own framing, marked accordingly), and it could **not confirm or refute the earlier-reported artifact-MCP granularity limitation** in Claude's admin controls (§2.7 states exactly what was and wasn't found).

---

## 0. Grounding: what Comparative already has

Comparative is **already MCP-based** — this spec is an extension of an existing architecture, not a green-field choice:

- **Every agent capability is an MCP tool (hard rule).** One MCP server per system of record; no in-process handlers. GitHub MCP is remote (`api.githubcopilot.com/mcp/`); Google/Notion/Salesforce are first-party endpoints under `/api/mcp/*`. Comparative sits on tiers (a)/(b) of the maturity ladder below.
- **Two auth layers are already separated.** Layer 1: identity into the shell (GitHub OAuth POC → **PingOne/PingFederate OIDC** for enterprise; `users.ping_subject` already holds the OIDC subject). Layer 2: shell → MCP per-user delegated OAuth — tokens in `oauth_tokens` (AES-256-GCM), a short-lived Bearer minted per turn and injected per-request. **Layer 2 is exactly the seam an EMA/ID-JAG flow would replace.**
- **A four-part governance spine exists:** `user_tool_attestations` (per-user approvals at read/write/admin action levels), admin-curated `tools_catalog` (enabled flags, action levels), the `mcp_servers` registry (**the admin allowlist already exists as data** — slug, transport, status active/disabled/planned), and the append-only `audit_log` (one redacted row per tool execution; denied providers get `status='denied'` rows).
- **The runtime per-action gap is already a named roadmap item:** "Human-in-the-loop confirmation before destructive `create_*`/write tool calls" (overview §8), first needed by the IT Request Agent.
- **The sibling memory spec already commits to Ping OIDC group claims as the one identity/group substrate.** This spec must reuse that substrate, not invent a parallel permission system.

---

## 1. The connector maturity ladder

The tier structure the prompt hypothesized is real and documented, though vendor docs use their own vocabulary (Anthropic: *connectors* vs *desktop extensions*). The verified taxonomy:

| Tier | What it is | Setup friction | Who vets/approves | Where the security exposure sits |
|---|---|---|---|---|
| **(a) Native / directory connectors** | Vendor-listed remote connectors ("The default choice and work everywhere you use Claude" — web, mobile, Cowork, Desktop, Claude Code) *(verified 3-0)* | One-click from catalog; zero per-surface setup ("Once connected, they're available everywhere without extra setup" — *verified 3-0*) | Vendor reviews against **listing criteria** but "doesn't security-audit or manage any MCP server" *(extracted, code.claude.com/docs/managed-mcp)*; org Owner enables per-connector | The connected SaaS + the vendor's brokering cloud; per-user OAuth scopes |
| **(b) Custom / remote MCP** | Paste-a-URL: any MCP server at a public HTTPS URL *(verified 3-0)* | Minutes; but server must be reachable from Anthropic's cloud — private servers need IP allowlisting *(extracted)* | **Anthropic explicitly does not vet these** *(verified 3-0)*; on Team/Enterprise **only Owners can add them** *(verified 3-0)*; on Pro/Max any user | Documented risks: prompt injection from malicious servers, **rug-pull** (tool behavior changing after approval) *(verified 3-0)*; data processed on third-party infrastructure |
| **(c) Desktop extensions** | Local MCP servers packaged as one-click `.mcpb`/`.dxt` bundles; Claude Desktop + Claude Code only *(verified 3-0)* | Low for users (bundled runtime, no deps); high for governance (endpoint fleet) | Anthropic-reviewed directory exists *(verified 3-0)*; org owners control a **per-extension allowlist** and can upload custom extensions *(verified 3-0)*; machine-level MDM policy **overrides in-app controls** *(extracted)* | The **endpoint**: extensions reuse the user's existing corporate network auth context, reaching internal systems with no new firewall rules *(verified 3-0)* — centralized token exchange (EMA) does not apply to this tier; creds sit in OS keychain *(extracted)* |
| **(d) Browser-use** | Harness drives a real browser for sites with no API/MCP | *(No verified claims returned in this run — from the prompt's framing:)* higher friction, slower, per-site brittleness | Effectively un-vettable at the site level | The user's live browser session — cookies, logged-in state |
| **(e) Computer-control** | Full desktop automation; last resort | *(No verified claims returned in this run)* — slowest, most expensive | — | The entire desktop |

Two cross-tier findings worth pulling out:

1. **The vetting burden inverts as you descend.** Tier (a) is partly vendor-vetted; tier (b) is explicitly *not* vetted by the vendor — official MCP docs put it on the end user: "Always verify the authenticity of remote MCP servers before connecting" *(verified 3-0)*. Any enterprise deployment must therefore re-insert an admin between the user and tiers (b)+(c).
2. **Tier (c) escapes centralized auth entirely.** Desktop extensions ride the endpoint's existing authenticated context *(verified 3-0)* — no token issuance event exists for an IdP to govern. For an enterprise, this tier is governed by endpoint management (MDM), not identity infrastructure.

**For Comparative this table mostly matters as a boundary-drawing tool** — see §4.1: Comparative should live on tiers (a)/(b) exclusively, which its architecture already does.

---

## 2. EMA and the connection-vs-runtime gap, explained plainly

### 2.1 What it is

**Enterprise-Managed Authorization (EMA)** is an official MCP extension — `io.modelcontextprotocol/enterprise-managed-authorization` — that "enables organizations to control MCP server access centrally through their existing identity provider (IdP). Instead of each employee authorizing each MCP server individually, the organization's IT or security team manages access policies in one place" *(verified 3-0, modelcontextprotocol.io spec page)*.

### 2.2 The mechanism

Verified 3–0 against the spec: **the MCP client requests an Identity Assertion JWT Authorization Grant (ID-JAG) from the enterprise IdP** (using the ID token/SAML assertion from SSO login), then **exchanges the ID-JAG for an access token from the MCP server's Authorization Server** — the spec explicitly instructs clients: "Do not redirect the user to the MCP Authorization Server's authorization endpoint." The user never sees a per-server consent screen *(verified 3-0)*.

Technical detail from secondary/blog sources *(extracted, consistent across three independent sources)*: the flow chains **RFC 8693 token exchange** (IdP issues the ID-JAG) with an **RFC 7523 JWT-bearer grant** (client redeems it for the MCP access token). Each ID-JAG is **audience-scoped to a single MCP server** and short-lived (~300 s in the spec's example); resulting access tokens can live up to 24 h. There is no universal cross-server token — one exchange per target server.

### 2.3 The governance model

All verified 3–0 or 2–0:
- **Admin enables a server once for the whole org; users inherit automatically, "scoped to the groups and roles they already have."**
- The IdP **evaluates access policies (group membership, role assignments, conditional access rules) before issuing tokens** — unauthorized users simply never get a token.
- **Revocation happens at the IdP level, taking effect immediately across all MCP clients.** Because checking access with the IdP is frictionless, admins can shorten token lifetimes without hurting productivity — deprovisioned users' access expires fast *(claude.com/blog claim; unverified-by-vote but quoted verbatim)*.
- **"Access decisions live in the IdP admin console, with one auditable trail across every connector"** *(verified 2-0)*.

### 2.4 Timeline — proposal to stable in ~9 months

| Date | Event |
|---|---|
| Sept 2025 | ID-JAG draft adopted by the IETF OAuth working group *(extracted, two secondary sources)* |
| Late 2025 | Okta ships **Cross App Access (XAA)** — the first working implementation *(extracted)* |
| Nov 2025 | Incorporated into the MCP specification *(extracted)* |
| **June 18, 2026** | **EMA declared stable** — official MCP blog post by core maintainer Paul Carleton, referencing SEP-990, spec hosted in `modelcontextprotocol/ext-auth` *(verified 3-0)*. Same day: Anthropic ships the **first implementation, in beta for Claude Team/Enterprise plans** *(verified 2-0)* |

Note the honest nuance: the *extension spec* is stable; Anthropic's *product implementation* was still labeled **beta** as of mid-July 2026 (the Claude help-center doc still says beta — *extracted*).

### 2.5 Ecosystem as of the research date (2026-07-14)

Verified 2–0 (MCP blog) with per-item corroboration from four additional sources:
- **IdP: Okta only** (via Cross App Access). Every source agrees; Azure AD and Google Workspace are described as "roadmap, no published timeline" *(extracted)*. ID-JAG is vendor-neutral — "EMA does not require Okta — it requires any IdP that implements the ID-JAG draft" *(extracted, techtimes)*. **No source mentions Ping Identity.** This is the single most consequential fact for the org — see §4.2.
- **Clients:** Claude, Claude Code, Cowork (implemented once in Anthropic's shared MCP layer, so one admin config covers all three surfaces — *extracted*), and VS Code (v1.123+ — *extracted*).
- **MCP servers:** Asana, Atlassian, Canva, Figma, Granola, Linear, Supabase, with Slack actively adding support *(verified 2-0)*. One source (byteiota) omits Granola from the launch list — minor discrepancy, majority + primary sources include it. Early *deployer* orgs cited: HubSpot, Ramp, Webflow *(extracted, single secondary source)*.

### 2.6 The gap EMA does not close — stated plainly

**EMA governs the connection; it does not govern the action. This is structural, not an implementation gap.** The clearest formulations from the research, all pointing the same way:

- "EMA is a connection-level control: it answers whether this user's client is allowed to reach this server, at what scope, at the moment the token is issued. It has no visibility into what happens after that — the IdP is not in the loop for the individual tools/call requests that follow." *(extracted, mcp.directory)*
- "EMA determines who may connect to what. It has nothing to say about whether a specific tool call, proposed by a potentially compromised agent five minutes after the token was issued, should actually execute." *(extracted, arcade.dev, 2026-06-23)*
- EMA also does not address prompt injection or malicious-server supply-chain risk *(extracted, techtimes)*.

**Is anything filling the runtime gap? Yes — but nothing standard.** As of mid-2026 the per-action layer is a fragmented, pre-standards space:

| Effort | Date | Shape | Status |
|---|---|---|---|
| **Microsoft Agent Governance Toolkit (AGT)** | 2026-04-22 | Open-source (MIT) control plane between MCP client and tool servers; declarative rules (YAML, OPA/Rego, Cedar) "evaluated deterministically before every tool invocation"; decisions resolve to **allow / deny / require approval**; append-only hash-chained per-call audit log; kill switches | Public Preview *(extracted, primary Microsoft blog)* |
| **Open Agent Passport (OAP)** (arXiv 2603.20953) | 2026-03 | Blocking `before_tool_call` hook; declarative versioned Policy Packs; signed audit records; **ESCALATE** (human approval) path *specified but not yet implemented*. Its CTF testbed is the best quantitative evidence in this run: permissive policy → **74.6% of social-engineering attempts succeed**; strict capability scoping → **0%** across 879 attempts | Paper + framework hooks (Claude Code PreToolUse, LangChain, CrewAI) *(extracted, primary)* |
| **Arcade.dev "Contextual Access"** | 2026-06-23 | Pre-execution hooks that allow/deny/modify tool calls; keeps raw credentials isolated from the LLM; explicitly composes with (not replaces) EMA/Okta/Entra | Vendor product *(extracted, vendor blog)* |
| **Claude's own admin controls** | mid-2026 | Per-permission tri-state on each connector: **"Always allow / Needs approval / Blocked"** — e.g. "Allow Claude to search and summarize email, but prevent it from sending messages" | Shipped in the harness *(extracted, support.claude.com)* |

The framing that matters: the March 2026 arXiv paper states there is **"no standard mechanism to enforce authorization before the action executes"** and Microsoft's April blog agrees MCP "provides no deterministic checkpoint." **The runtime gap is open at the standards level and being filled by proprietary/harness-specific layers.** Supporting evidence that the gate must be deterministic, not prompt-based: Microsoft's internal red-team found prompt-only safety instructions produced a **26.67% policy violation rate** *(extracted)*.

### 2.7 The complementary admin allowlist — and how it composes with EMA

The allowlist and EMA answer different questions: **"what is in scope at all"** (allowlist) vs. **"how does auth work for what's in scope"** (EMA). Both exist in Claude today, and the reference implementation is instructive:

- **claude.ai org level:** connectors are **disabled by default** on Team/Enterprise; an Owner/Primary Owner enables each one *(extracted)*. Per one primary doc (Claude for Government context): granularity is **org-wide on/off per connector — "per-user or per-group connector gating is not currently available"** *(extracted)*; group-scoped access is exactly what the EMA beta adds on top.
- **Claude Code:** `managed-mcp.json` gives admins exclusive control of the server set; `allowedMcpServers`/`deniedMcpServers` match by URL or command (per-server granularity, including "disable MCP entirely" via an empty map). Two sharp edges worth copying into any design: allowlists are only authoritative with `allowManagedMcpServersOnly: true` (otherwise user settings merge in and **users can broaden the allowlist**), and **name-based entries are explicitly not a security control** — enforce by URL/command *(extracted, code.claude.com/docs/managed-mcp)*.
- **Desktop extensions:** separate per-extension org allowlist *(verified 3-0)*.

**On the prompt's specific question about artifact-MCP granularity** (earlier reporting: admins could turn off artifact-MCP access org-wide but not manage which specific servers artifacts use): **this run could not confirm or refute it.** None of the fetched admin docs mention artifact-MCP controls at all (one fetch note records the absence explicitly). Treat it as unresolved; if it matters for an org decision, it needs a direct check of current Claude admin settings rather than documentation.

---

## 3. NHI / machine-credential governance

EMA solves user-facing consent. Underneath it, every connector still runs on machine credentials with their own lifecycle. Notably, **the two literatures barely reference each other as of mid-2026** — GitGuardian's May 2026 MCP governance framework never mentions EMA/ID-JAG/Okta, and CSA's May 2026 whitepaper never mentions MCP by name *(both extracted)* — confirming these are separate layers an implementer must compose deliberately.

**The consensus 2026 framework** (CSA whitepaper May 2026 + GitGuardian MCP framework May 2026 + corroborating industry posts):

1. **Centralized NHI registry** — system-of-record per non-human identity: owner, purpose, privilege scope, expiration. "No credential should exist outside of a lifecycle management process" *(extracted, CSA)*. Every NHI gets a **named human owner** *(extracted, two sources)*.
2. **Zero standing privilege / just-in-time access** — task-scoped, time-limited, auto-revoked *(extracted, CSA)*.
3. **Least-privilege scoping** — minimum permissions per MCP server; separate credentials per environment (prod/staging/dev); no shared credentials across servers *(extracted, GitGuardian)*.
4. **Rotation at the shortest operationally compatible interval** — CSA: hours for ephemeral agents, days/weeks for persistent ones; revocation workflows pre-authorized, targeting **minutes, not hours** *(extracted)*. GitGuardian's concrete TTLs: OAuth tokens measured in **hours**, API keys ≤ **90 days**, DB credentials ≤ **30 days** *(extracted)*.
5. **Exposure detection** — continuous secret scanning across repo history, CI/CD output, and collaboration tools *(extracted, GitGuardian)*.
6. **Workload identity where possible** — SPIFFE/SPIRE-style short-lived attestation-based certificates over static keys; ABAC over RBAC for dynamic agents *(extracted, CSA)*.

**Why the urgency is real (the numbers, all extracted):** NHIs outnumber humans 45:1 on average, 144:1 in cloud-native environments (CSA); 51% of orgs report no clear ownership of AI identities; only 20% have formal API-key offboarding; 71% of NHIs aren't rotated within recommended timeframes; 28.65M hardcoded secrets hit public GitHub in 2025; AI-related secrets were the fastest-growing exposure category (+81% YoY). MCP-specific: the protocol "ships with no authentication enabled by default" *(extracted)*.

**How it composes with EMA:** EMA moves the *consent* event to the IdP but the *tokens* still exist — short-lived ID-JAGs, longer-lived access tokens, plus whatever service credentials the MCP servers themselves hold. NHI governance is the discipline for that machine layer. An org adopting EMA without an NHI program has centralized the front door while leaving the key cabinet unmanaged.

**Comparative-specific recommendation:**
- `oauth_tokens` + `mcp_servers` are the seed of the NHI registry. Add to `mcp_servers`: a **named owner** (org employee accountable for the integration), **credential type**, **rotation TTL**, and **last-rotated** — four columns, not a new system.
- Comparative's per-turn short-lived Bearer minting is already the right shape (hours-scale OAuth TTLs). The open question in the overview (§10.2, per-turn vs ~50-min cached token) should be decided *with the CSA rotation guidance in hand* — both options are inside best practice; a cached token beyond ~1 h for scheduled runs would not be.
- M2M/stdio integrations (service principals in MCP process env) are the weak spot: they're exactly the static, long-lived credentials the framework warns about. Rotate on the GitGuardian TTLs; store only in Secrets Manager (already the pattern); add secret scanning to CI as a cheap pillar-5 win.
- Tie **deprovisioning** to the same Ping SCIM/OIDC signal the memory spec uses for departure handling: user leaves → `oauth_tokens` rows revoked + purged, attestations revoked, audit row written. Target minutes, not a batch job.

---

## 4. Recommended connector + admin model for Comparative

### 4.1 Where Comparative lives on the ladder — and the tiers it should refuse

**Recommendation: tiers (a) and (b) only, admin-gated; explicitly no (c), (d), (e).**

- Comparative is a server-side product; desktop extensions (c) don't apply and would violate the thin-shell boundary rule (governing an endpoint fleet is IT's job, not Comparative's).
- Browser-use (d) and computer-control (e) fail the product boundary test ("remove enterprise friction, don't rebuild a platform") and would bypass the entire MCP governance spine — no `tools_catalog` entry, no attestation, no per-tool audit row. If a target system has no API, the answer is a first-party MCP server (the existing pattern), not a browser.
- Within tier (b): **no end-user paste-a-URL, ever.** Claude's own model restricts custom-connector addition to org Owners on enterprise plans *(verified 3-0)*, and Anthropic's documented risks (prompt injection, rug-pull) are exactly why. Comparative's equivalent: new MCP servers enter via the `mcp_servers` registry, added by admins only.

**Who approves what (the two-step model):**

| Action | Who | Mechanism (exists today?) |
|---|---|---|
| Add a new connector to the org | Comparative admin (+ integration owner sign-off, §3) | `mcp_servers` registry row — exists |
| Enable/disable individual tools on a connector | Comparative admin | `tools_catalog` enabled flag — exists |
| Connect *my* account to an enabled connector | Any org employee, self-service | Per-user OAuth (`oauth_tokens`) + attestation — exists |
| Use a tool at a given action level | Automatic check per turn | Tool gate: attestation + catalog — exists |

This mirrors the informal process you already run for Claude Teams seat/connector requests — the spec's job is to make that process a first-class admin surface rather than a Slack thread.

### 4.2 EMA now, or admin-allowlist-first? — Allowlist-first, EMA-shaped, with a clean upgrade seam

**Recommendation: do not target EMA directly today. Build the allowlist + group-scoping model in the shell now, shaped so EMA slots in later.** Three reasons, in order of force:

1. **The org runs PingOne/PingFederate. EMA ships Okta-only** as of 2026-07-14, with no Ping announcement found. ID-JAG is vendor-neutral, so Ping *could* implement it — but that is a Ping product decision plus an org IT adoption decision, and Comparative controls neither.
2. **Comparative already holds the seam.** The shell is the MCP client; it already mints and injects per-turn tokens (Layer 2). When an ID-JAG-capable IdP is available, "adopt EMA" means changing *how the shell obtains tokens* — an implementation swap inside one module, invisible to users, tools, audit, or the runtime.
3. **Most of EMA's governance value is available without EMA.** Admin-enables-once (registry), group-scoped access (Ping OIDC group claims — the same substrate the memory spec commits to), central revocation (shell revokes `oauth_tokens` + attestations), short token lifetimes (already per-turn). What Comparative *can't* replicate alone is the elimination of the per-user OAuth consent dance against each SaaS — that genuinely requires IdP-side ID-JAG support and connector-side support.

**The organizational answer the prompt asks for, plainly:** getting the org onto a true EMA model is **not a Comparative decision alone — it requires org IT/identity-team buy-in regardless of what Comparative builds**, because the IdP is the policy decision point (the connector registry, group scoping, and token issuance all live in the IdP admin console under EMA). Concretely it needs: (1) Ping shipping ID-JAG/XAA-equivalent support (external dependency), (2) the org identity team configuring the MCP-server registry and group policies in Ping, (3) target connectors supporting EMA (the current seven-plus-Slack list covers few of the org's Tier-1 systems — notably **neither Salesforce nor M365 appears** in any launch list found). Comparative's correct move is to be *EMA-ready* (clean token-acquisition seam, group-claim scoping already wired) and to hand org IT a one-page ask when Ping support materializes. Note the same conversation is coming for the org's other harnesses (Claude Teams itself, VS Code) — an org-IT-level EMA decision benefits Comparative even if Comparative moves last.

### 4.3 The audit trail: what the admin view actually shows

`audit_log` today records tool *executions*. PBM-style accountability ("who connected what, on whose behalf, when was it revoked") needs the **connection lifecycle** as first-class events. Concretely, a `/admin/connectors` view with three tabs:

1. **Connectors (org level):** per `mcp_servers` row — status, named owner, auth mode, credential TTL/last-rotated, date enabled, enabled-by, tool count (enabled/total from `tools_catalog`), connected-user count.
2. **Connections (user × provider):** who connected (user), to what (provider), when (OAuth grant timestamp), attestation scope granted (provider/category/tool + max action level), last used (join to `runs`/`audit_log`), **revoked when / by whom / why** (user-initiated, admin-initiated, deprovisioning). This is mostly a projection over `oauth_tokens` + `user_tool_attestations` — the data largely exists; the missing pieces are revocation-reason and admin-actor columns.
3. **Decisions (event stream):** append-only connection-lifecycle events written to `audit_log` with new action types: `connector.enabled`, `connector.disabled`, `connection.granted`, `attestation.granted`, `attestation.revoked`, `connection.revoked`, `user.deprovisioned`. Same ledger as tool executions — one trail, filterable, exactly the "one auditable trail across every connector" property EMA advertises, owned by the shell instead of the IdP.

### 4.4 The runtime gap: Comparative's own answer

**Recommendation: adopt the tri-state per-tool policy Claude shipped — `always_allow` / `needs_approval` / `blocked` — as a `tools_catalog` column, enforced deterministically in the shell's tool gate, with decisions audited.** Defaults by action level:

- **read** → `always_allow` (attestation still required — this is the tiered auto-allow for read-only the prompt suggests).
- **write** → `needs_approval`: the run pauses, the user (or for scheduled/event runs, the Skill owner) gets a confirmation with the redacted tool input, approve/deny resumes or cancels. This lands exactly on the existing roadmap item (HITL before destructive `create_*` calls) and the existing run-lifecycle machinery (`runs` lease/resume, `run_events`) is the right substrate for "paused awaiting approval."
- **admin** → `blocked` by default; admins opt individual tools up.

Design rules imported from the research, each with a source behind it:
- **The gate must be deterministic shell code, never a prompt instruction** (Microsoft: prompt-only safety → 26.67% violation rate) and never delegated to the runtime (the overview's ownership rule already says governance is the shell's job).
- **The decision is part of the audit record** — extend the per-execution `audit_log` row with `policy_decision` (auto-allowed / approved-by-user / denied / blocked), echoing AGT's per-call decision logging.
- **Approval fatigue is the failure mode to design against** (HITL is used by ~40% of orgs precisely because it scales poorly — *extracted*). Mitigations: approvals batched per turn, not per call; per-Skill standing approvals for specific write tools ("this Skill may always file Workfront tickets") recorded as scoped attestations with an expiry; and the OAP tiering evidence (74.6% → 0%) as the argument for keeping strict defaults even when users grumble.
- **Don't build a policy-engine dependency now.** OPA/Cedar-style engines (AGT) are the right shape for a platform vendor; Comparative needs three states and an approval queue. Revisit only if per-argument policies (e.g. spend limits) become real requirements.

---

## 5. Does this close the Salesforce-sharing scenario?

The scenario from the artifact research: a user builds a Salesforce-backed dashboard/artifact and shares it; the question was whether recipients' access is checked against *their own* Salesforce permissions.

**What the recommended model closes:**
- **Connection-time — closed, and Comparative was already right.** Shares execute with **recipient credentials** (J5 seed): a recipient without their own Salesforce connection + attestation gets nothing. EMA's contribution here would only ever be convenience (recipients inherit the *ability to connect* without an OAuth dance) — the authorization semantics Comparative already has are the correct ones, and stricter than pre-EMA Claude (where org-enabled connectors still can't be group-scoped — *extracted*).
- **Runtime — closed for actions.** With §4.4, a shared Skill that *writes* to Salesforce pauses for the recipient's approval; read tools run only against data the recipient's own token can see.

**What it does not close — stated plainly:**
- **Baked data.** A `workspace_artifacts` HTML artifact embeds whatever data the *builder's* credentials returned at build time. Sharing that artifact shares the builder's data snapshot with no Salesforce check on the recipient — no connector-governance mechanism (EMA, allowlist, tri-state, NHI) touches this, because no tool call happens at view time. This is a data-provenance problem: artifacts built from connector data need either (i) a share-time warning/block ("contains data from Salesforce fetched as `<builder>`"), or (ii) live-fetch-on-view semantics (recipient's token re-runs the queries), which is a J4 architecture decision. Until one of those exists, **the honest answer is: the connector model closes the tool-access gap; the artifact-snapshot gap from the original scenario remains open** and should be tracked as its own item in the J4/J5 spec work.
- **Data-level appropriateness.** Even with per-action gating, "should this specific record be visible to this specific audience" is a judgment no 2026 mechanism found in this research automates. The industry's current answer is the maker-checker human pattern *(extracted, arcade.dev)* — which is what `needs_approval` implements.

---

## 6. Open questions / risks

1. **Ping ID-JAG support — external, no signal.** No evidence found of Ping Identity implementing ID-JAG/XAA. Risk: the EMA upgrade path (§4.2) has no date. Mitigation: the allowlist-first model is complete on its own; EMA is an upgrade, not a dependency. Worth a periodic check of Ping's roadmap and the MCP client/IdP matrix.
2. **EMA connector coverage vs. the org's Tier-1 systems.** Launch connectors (Asana, Atlassian, Canva, Figma, Granola, Linear, Supabase, Slack-soon) barely intersect the org's stack (M365, Salesforce, Workfront, Databricks, ServiceNow, SAP). Even with Ping support, first-party org integrations would still authenticate via Comparative's own Layer-2 machinery for a long time.
3. **Anthropic's implementation is beta.** The spec is stable (June 18, 2026); the flagship implementation is not. If the org adopts EMA for Claude Teams itself, expect beta-grade edges.
4. **Scheduled/event runs stretch token lifetimes.** The overview's open question §10.2 (per-turn vs cached tokens) compounds with J3: a nightly Skill needs a valid token at 2 a.m. with no user present. CSA guidance says hours-scale TTLs; refresh-token handling for offline runs needs its own design pass and is *not* settled by this spec.
5. **Approval-queue UX for non-interactive runs.** `needs_approval` on a scheduled run means a notification → approve flow with a timeout policy (auto-cancel? hold-and-expire?). Unspecified here; needed before the IT Request Agent ships.
6. **Artifact data provenance (from §5)** — open, tracked to J4/J5.
7. **Name-vs-endpoint enforcement.** Claude Code's documented sharp edge (name-based allowlist entries are not a security control) applies to Comparative too: `mcp_server_slugs` on Skills are labels; the gate must resolve and enforce against the registry's endpoint/command, not the slug string.
8. **Unverified-claim residue.** Three claims (Okta-only IdP, exact launch-partner list, first-implementation status) failed to get 3 independent votes due to session limits, though all are corroborated by 3-0/2-0-verified claims from the official MCP blog and appear verbatim in Anthropic's announcement. The browser-use/computer-control tiers and the artifact-MCP granularity question got no verified coverage at all (§ coverage note).

---

## 7. Sources (with dates)

**Primary — MCP project:**
- EMA extension spec — modelcontextprotocol.io/extensions/auth/enterprise-managed-authorization (stable tree, `modelcontextprotocol/ext-auth`; fetched 2026-07-14)
- "Enterprise-Managed Authorization: Zero-touch OAuth for MCP" — blog.modelcontextprotocol.io (2026-06-18, Paul Carleton)
- Connect to remote servers — modelcontextprotocol.io/docs/develop/connect-remote-servers (fetched 2026-07-14)

**Primary — Anthropic:**
- claude.com/blog/enterprise-managed-auth (2026-06-18)
- support.claude.com: 11725091 when-to-use-desktop-and-web-connectors (2026-04-15); 11175166 custom connectors via remote MCP (2026-04-02); 10949351 local MCP on Claude Desktop; 12702546 enterprise desktop extensions (2026-03-16); 15537633 authorize MCP connectors org-wide; 14503689 MCP connectors (gov context); 11176164 use connectors (all fetched 2026-07-14)
- code.claude.com/docs/en/managed-mcp (live doc, fetched 2026-07-14)

**Primary — runtime gap & NHI:**
- Microsoft, "Securing MCP: a control plane for agent tool execution" (Agent Governance Toolkit) — developer.microsoft.com (2026-04-22)
- Open Agent Passport — arxiv.org/html/2603.20953v1 (2026-03-21)
- CSA whitepaper, "Non-Human Identity & Agentic AI Governance" — labs.cloudsecurityalliance.org (2026-05-20)

**Secondary / blog (corroboration + technical detail):**
- InfoQ MCP EMA coverage (2026-07-06); TechTimes ×2 (2026-06-19); ehosseini.info EMA deep-dive (2026-06-21); mcp.directory EMA explainer (July 2026); byteiota (2026-06-19); arcade.dev "Beyond EMA: per-action authorization" (2026-06-23); GitGuardian MCP governance framework (2026-05-20); christian-schneider.net NHI governance gap (2026-07-07); veeam.com NHI security guide (2026-04-29); 4sysops connector taxonomy (2025-07-21)

### Verification notes

Deep-research run 2026-07-14 (resumed 2026-07-17 after session-limit interruption): 6 search angles → 26 sources → 130 extracted claims → top 25 adversarially verified with 3 independent refutation votes each → **22 confirmed, 0 refuted, 3 unverified** (verifier votes lost to session limits; all three corroborated by verified claims from independent primary sources). Synthesis was performed by the authoring session rather than the workflow's synthesis agent (session limit); all claim-to-source attributions above were made against the workflow journal's per-source extraction records, each carrying a verbatim quote.
