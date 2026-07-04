# ADR 0004 - AgentCore Gateway integration pattern

- **Status:** Proposed
- **Date:** 2026-07-03
- **Deciders:** Rob, Comparative engineering, InfoSec for connector credential review
- **Related:** [docs/agentcore-migration/specs/gateway-targets.md](../agentcore-migration/specs/gateway-targets.md), [docs/agentcore-migration/05-adr/003-gateway-as-tool-layer.md](../agentcore-migration/05-adr/003-gateway-as-tool-layer.md), [docs/agentcore-migration/05-adr/004-identity-on-behalf-of.md](../agentcore-migration/05-adr/004-identity-on-behalf-of.md), [docs/ARCHITECTURE.md](../ARCHITECTURE.md)

## Context

Comparative's first tool integrations grew from the fastest path available:
GitHub is a remote MCP endpoint and Notion is a same-origin relay backed by
per-user OAuth tokens in `oauth_tokens`. That is acceptable for a small pilot,
but the next integrations - Gmail, Calendar, Salesforce, M365, Workfront,
ServiceNow, Databricks, and SAP - need a repeatable enterprise pattern.

The product already has the governance spine:

- `mcp_servers` is the admin registry of mountable providers.
- `tools_catalog` is the user-visible catalog of enabled provider-native tools.
- `user_tool_attestations` records per-user approval by provider, category, or
  individual tool.
- `audit_log` records tool execution and denied access events.

If each integration becomes bespoke application code, every provider must
re-implement OAuth, refresh, token storage, tool naming, audit, prompt-injection
framing, and runtime mounting. That does not scale and weakens the enterprise
story. AgentCore Gateway gives us a managed boundary for API targets,
on-behalf-of credentials, semantic tool selection, and Gateway-side call audit.

The Salesforce Gateway spike runbook has not been completed end-to-end yet.
This ADR should therefore land as **Proposed** until the spike or the first
Gmail/Calendar Gateway target validates the command shapes and operational
details.

## Decision

Use **AgentCore Gateway as the default integration pattern for new stateful
business-system integrations**.

For a new provider, the normal unit of work is:

1. A provider target definition: OpenAPI, Smithy, HTTP passthrough, or Lambda
   shim.
2. An AgentCore Gateway target with outbound auth configured through the
   Gateway/Identity credential provider.
3. Registry and catalog rows in `mcp_servers` and `tools_catalog`.
4. User attestation wiring through `user_tool_attestations`.
5. Runtime mounting that allows only attested, enabled tools for the current
   user and task.
6. Redacted audit rows in `audit_log` for allowed, denied, succeeded, and failed
   tool calls.

### Mapping to existing tables

- `mcp_servers.slug` is the stable provider slug, for example `google-mail`,
  `google-calendar`, `salesforce`, or `m365-graph`.
- `mcp_servers.transport` remains the product-facing mount type. Gateway-backed
  providers should use HTTP-compatible transport and record Gateway-specific
  details in `metadata`, including Gateway target ARN/name, auth type, allowed
  scopes, and deployment region.
- `tools_catalog.provider` matches `mcp_servers.slug`.
- `tools_catalog.tool_name` stores the provider-native operation id exposed
  through Gateway, not a rewritten model-facing name.
- `tools_catalog.metadata` may record the Gateway operation id, target name,
  source OpenAPI path, rate-limit class, and whether the tool returns untrusted
  document/message content.
- `user_tool_attestations` remains the product approval gate. A connected OAuth
  credential does not by itself expose tools to the model; an active attestation
  for the provider/category/tool is still required.
- `audit_log.provider` and `audit_log.tool_name` use the same provider/tool keys
  as the catalog. `metadata` should include the Gateway request id or trace id
  when available.

### Per-user OAuth and credentials

Per-user systems use on-behalf-of OAuth through the Gateway/Identity credential
provider. The runtime receives the authenticated Comparative user id as the
actor and may request only tools authorized for that actor.

The model must never receive raw access tokens, refresh tokens, client secrets,
or tenant-level service credentials. Service-principal integrations are allowed
only when the source system cannot support delegated user auth, and must carry
the Comparative actor id into audit metadata so source-system or Gateway logs
can still be tied back to the user action.

### Prompt-injection framing

Tool results from email, calendar, docs, CRM notes, tickets, web pages, and
other user or third-party content are untrusted data. Gateway-backed tool
adapters must wrap natural-language content in nonce-delimited data blocks
before it is added to model context, matching the existing Notion, web fetch,
skill, and artifact-context pattern.

The framing rule is:

- one fresh nonce per tool result or bundled result set;
- explicit text saying the enclosed content is untrusted data;
- no instruction-following from inside the data block;
- redaction before persistence into `audit_log` or run output.

### Naming and tool selection

Provider slugs should describe the business system, not the implementation
detail. Use `google-mail`, `google-calendar`, `salesforce`, `m365-graph`,
`workfront`, and similar names. Avoid slugs like `gateway-google-mail`; Gateway
is the transport pattern, not the user-facing provider.

Tool names should stay close to the source operation id and be grouped by
provider/category in `tools_catalog`. Runtime prompts may describe the business
capability, but catalog keys must remain stable for attestation and audit.

Gateway semantic tool selection can be enabled when a provider exposes enough
tools that registering all of them would bloat prompts or weaken model choice.
Semantic selection is an optimization layer; it does not bypass
`tools_catalog`, `user_tool_attestations`, or per-turn allowed-tool scoping.

### Grandfathered integrations

GitHub stays on the existing remote MCP path because it is already MCP-native.
Do not route GitHub through Gateway unless the current endpoint becomes
insufficient for auth, audit, or enterprise deployment.

Notion stays on the current same-origin relay for now. It should be migrated to
a Gateway HTTP passthrough target only when Gateway can preserve the same
per-user OAuth, nonce-framed content, and audit guarantees with less bespoke app
code.

## Consequences

**Positive**

- New integrations become target specs plus catalog/governance wiring, not a
  new bespoke runtime path every time.
- Credentials move out of model-visible and application-managed execution paths.
- The product keeps one approval model: connect credentials, attest tools, audit
  every call.
- Tool names, provider slugs, and audit rows remain stable across runtime
  changes.
- Gateway semantic selection gives a path to larger provider surfaces without
  dumping every tool into every prompt.

**Negative / risks**

- Gateway and Identity setup may lag the app code for each provider.
- Local development and tests need mocks or fixtures for Gateway responses.
- Some providers may still require Lambda shims because their APIs are not clean
  OpenAPI targets.
- Dual operation will exist for a while: GitHub remote MCP, Notion relay, and
  Gateway-backed providers.
- The Salesforce spike is still a validation gate; exact CLI and IaC shapes may
  change as AWS AgentCore evolves.

## Alternatives considered

- **Keep building first-party routes per provider.** Rejected as the default:
  it duplicates OAuth, refresh, audit, rate-limit, and prompt-injection handling
  in application code for every integration.
- **Use remote MCP for every provider.** Rejected for providers that do not
  already expose a mature MCP endpoint. We would still own auth translation and
  enterprise audit behavior.
- **Route every tool through Gateway immediately.** Rejected for current GitHub
  and Notion. GitHub already works as remote MCP, and Notion should not migrate
  until Gateway reduces complexity without weakening behavior.
- **Let connected OAuth imply model access.** Rejected. Credentials and model
  tool exposure are separate decisions; `user_tool_attestations` remains the
  product approval boundary.

## Revisit when

- The Salesforce or Gmail/Calendar Gateway implementation proves Gateway cannot
  preserve per-user OAuth, nonce-framed data, or audit guarantees.
- Gateway semantic selection is too slow, expensive, or opaque for large
  provider surfaces.
- A provider ships a first-party MCP endpoint that is clearly better than a
  Gateway target.
- InfoSec requires a different token-vault or audit boundary.
- We need write-capable workflows where source-system transaction semantics
  require a provider-specific runtime rather than a generic Gateway call.
