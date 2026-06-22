# ADR 003 — AgentCore Gateway as the tool layer

- **Status:** Proposed
- **Date:** 2026-06-19
- **Deciders:** Rob, InfoSec (outbound-auth / token-vault review)
- **Context docs:** [gateway-targets](../specs/gateway-targets.md), [02 §4](../02-target-architecture.md), [security](../specs/security-and-compliance.md)

## Context

Today the agent reaches external systems as MCP tools, with **per-user OAuth tokens decrypted in the
web process and injected as bearer headers** ([apps/web/lib/oauth/mcp-servers.ts](../../../apps/web/lib/oauth/mcp-servers.ts),
[crypto.ts](../../../apps/web/lib/oauth/crypto.ts)). Only GitHub + Notion ship; Databricks/Teams/Workfront
are placeholders; SAP/M365/Salesforce/ServiceNow are roadmap. As the tool count grows, we need managed
inbound+outbound auth, semantic tool selection, scoping, and audit without hand-rolling each one.

## Decision

Use **AgentCore Gateway** as the tool layer for stateful enterprise systems with real APIs
(SAP, M365, Databricks, Workfront, Salesforce, ServiceNow), with **outbound auth via the AgentCore
Identity token vault** (per-user OAuth or service-principal). Keep already-MCP-native tools (GitHub) as
`remote_mcp`; migrate Notion off its same-origin relay to a Gateway HTTP passthrough; use
`inline_function`/built-ins for trivial helpers (web fetch, code interpreter, browser).

## Options

1. **Keep in-process MCP + decrypt-and-bearer (status quo).** Rejected at scale: we own every
   integration's auth/refresh/audit; the model path holds decrypted creds; no semantic selection.
2. **Gateway for everything incl. GitHub/Notion.** Rejected: GitHub is already MCP-native; forcing it
   through Gateway adds translation for no gain.
3. **Gateway for enterprise targets + remote_mcp for MCP-native + inline for trivial (chosen).**

## Consequences

**Positive:** model never sees raw credentials (token vault mints per-call, per-user tokens) — a
security upgrade; managed in/out auth + audit + semantic selection; scoping via `allowedTools` glob +
target scopes; new integrations become target specs, not bespoke code.

**Negative / risks:** Identity-vault connector setup per system (auth is the hard part, esp. SAP);
Notion relay rework ([04 S4](../04-open-questions.md)); we must keep our redacted `auditLog`/attestation
in the shell so the honesty guarantees survive ([01 §9](../01-current-state.md)); InfoSec must review
the token vault.

**Migration impact:** the existing attestation gate ("connect X to run this",
[tool-attestations.ts](../../../apps/web/lib/tool-attestations.ts)) maps to "has the user authorized
this Gateway target in the vault?" — UX preserved, mechanism moved.
