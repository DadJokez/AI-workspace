# Spec — AgentCore Gateway Targets

> One target spec per enterprise system. Gateway converts OpenAPI / Smithy / Lambda into MCP tools, fronts
> HTTP/A2A via passthrough, and provides managed inbound + outbound auth, semantic tool selection,
> and audit. ARNs/URLs are placeholders pending the IaC pass.

## Assumptions

- Gateway is the tool layer for **stateful enterprise systems with real APIs**. Already-MCP-native
  tools (GitHub) use `remote_mcp`; the Notion same-origin relay is a special case (see notes).
- Outbound auth uses the **AgentCore Identity token vault** (per-user OAuth or service-principal),
  replacing today's in-process `oauth_tokens` decrypt + bearer-header injection
  ([apps/web/lib/oauth/mcp-servers.ts](../../../apps/web/lib/oauth/mcp-servers.ts)).
- Inbound auth to Gateway: the harness execution role (SigV4) + per-invocation `allowedTools` glob
  scoping; user-level scoping via `actorId` + target scopes.
- Decision matrix per integration: **Gateway target** (managed API, needs in/out auth, semantic
  selection) vs **`remote_mcp`** (already an MCP server) vs **`inline_function`** (trivial pure logic).

## Selection matrix

| Integration | Choice | Rationale |
|---|---|---|
| SAP ERP (FI) | Gateway target (OpenAPI or Lambda shim) | complex module-specific auth + scopes; the wedge use case |
| M365 Graph | Gateway target (OpenAPI) | huge surface; per-user delegated auth best brokered by Identity |
| Databricks | Gateway target (OpenAPI/Lambda) | SQL + workspace APIs; service-principal auth |
| Workfront | Gateway target (OpenAPI) | standard REST + OAuth |
| Salesforce / ServiceNow | Gateway 1-click / target | Gateway ships 1-click for Salesforce |
| GitHub | `remote_mcp` | already MCP-native (`api.githubcopilot.com/mcp/`) |
| Notion | `remote_mcp` (shell relay) → migrate to Gateway HTTP passthrough | relay is same-origin + HMAC today; passthrough decouples it |
| web search | Gateway target now → built-in `agentcore_web_search` when GA | first-party tool "coming soon" |
| web fetch | `inline_function` / built-in | trivial |

---

## Target: `sap-erp-fi` (the wedge)

| Field | Value |
|---|---|
| Target name | `sap-erp-fi` |
| Type | OpenAPI (preferred) or Lambda target (`arn:aws:lambda:us-east-1:<AWS_ACCOUNT_ID>:function:gw-sap-erp-fi`) |
| OpenAPI spec | `s3://acme-comparative-gateway/specs/sap-erp-fi.yaml` (FI module subset: budget, GL reads) |
| Outbound auth | Identity vault — SAP BTP OAuth (per-user) **or** service-principal via SAP API Gateway (TBD per module, [ROADMAP.md:220](../../ROADMAP.md)) |
| Allowed scopes | `fi.budget.read`, `fi.gl.read` (read-only to start; **no writes until InfoSec sign-off**) |
| `allowedTools` glob | `@sap-erp-fi/*` |
| Rate limit | start 5 rps / 300 rpm per actor (SAP is fragile; tune after PoC) |
| Notes | RFC-gated (Tier 3, [ROADMAP.md:190](../../ROADMAP.md)). PoC against FI budget read first. Auth is the hard part — every transaction code is its own scope. |

## Target: `m365-graph`

| Field | Value |
|---|---|
| Target name | `m365-graph` |
| Type | OpenAPI (Microsoft Graph subset) |
| OpenAPI spec | `s3://acme-comparative-gateway/specs/m365-graph.yaml` (mail, calendar, files read; mail send gated) |
| Outbound auth | Identity vault — Entra delegated OAuth (per-user); maps to existing `teams.ts` placeholder ([packages/mcp-servers/src/teams.ts](../../../packages/mcp-servers/src/teams.ts)) |
| Allowed scopes | `Mail.Read`, `Calendars.Read`, `Files.Read.All`; `Mail.Send`, `Chat.ReadWrite` behind explicit attestation |
| `allowedTools` glob | `@m365-graph/*` (or narrower per skill) |
| Rate limit | 10 rps / 600 rpm per actor (respect Graph throttling) |
| Notes | Consolidates the roadmap `teams`/`graph-mail`/`graph-cal`/`graph-files` placeholders into one Graph target. |

## Target: `databricks`

| Field | Value |
|---|---|
| Target name | `databricks` |
| Type | OpenAPI (SQL Statement Execution + Workspace) or Lambda shim |
| Outbound auth | Identity vault — Databricks **service principal (M2M)**; `actorId` carried as audit tag (per [databricks.ts](../../../packages/mcp-servers/src/databricks.ts)) |
| Tools | `run_sql`, `list_tables`, `describe_table`, `get_query_status` (from the placeholder) |
| Allowed scopes | warehouse read; **notebook write/run excluded** (graduates to Strands-on-Runtime, [ROADMAP.md:221](../../ROADMAP.md)) |
| `allowedTools` glob | `@databricks/run_sql`, `@databricks/list_tables`, `@databricks/describe_table` |
| Rate limit | 5 concurrent queries / actor; statement timeout 60s |
| Notes | Powers the marketing-analytics agent (SQL → Code Interpreter → chart). |

## Target: `workfront`

| Field | Value |
|---|---|
| Target name | `workfront` |
| Type | OpenAPI |
| Outbound auth | Identity vault — per-user OAuth |
| Allowed scopes | project/task read; status update behind attestation |
| `allowedTools` glob | `@workfront/*` |
| Rate limit | 10 rps / actor |

## Target: `salesforce` / `servicenow`

| Field | Value |
|---|---|
| Type | Gateway 1-click (Salesforce) / OpenAPI (ServiceNow) |
| Outbound auth | Identity vault per-user OAuth |
| Scopes | read-first; writes gated |
| Notes | Lower priority; placeholders in ROADMAP. |

---

## `remote_mcp`: GitHub

| Field | Value |
|---|---|
| Tool type | `remote_mcp` |
| Endpoint | `https://api.githubcopilot.com/mcp/` |
| Auth | Identity vault OAuth (`repo read:user`), replacing in-process bearer ([oauth/mcp-servers.ts](../../../apps/web/lib/oauth/mcp-servers.ts)) |
| `allowedTools` glob | `@github/*` or per-skill subset |
| Notes | Already MCP-native; no Gateway translation needed. |

## `remote_mcp` (special): Notion

| Field | Value |
|---|---|
| Today | same-origin relay `POST /api/mcp/notion` with HMAC `X-Comparative-MCP-Relay` ([apps/web/lib/notion/mcp.ts](../../../apps/web/lib/notion/mcp.ts)) |
| Risk | the relay assumes the **shell's origin** — a managed Harness microVM may not reach it the same way (see [02 §10](../02-target-architecture.md)) |
| Target state | re-host as a **Gateway HTTP passthrough target** with Identity-vault OAuth, dropping the HMAC relay; OR keep Notion turns on a shell-side path until migrated |
| `allowedTools` glob | `@notion/*` |

## Cross-cutting

- **Semantic tool selection:** with SAP+M365+Databricks+Workfront+GitHub+Notion the tool count grows;
  enable Gateway semantic search so the agent sees only contextually relevant tools (cuts prompt size
  and the `$0.025/1k` search cost is marginal — see [cost-model.md](cost-model.md)).
- **Audit:** Gateway call logs feed GenAI Observability; the shell still writes the redacted
  `auditLog`/`run_events` rows it writes today ([audit-tool-events.ts](../../../apps/web/lib/audit-tool-events.ts))
  so the existing honesty/attestation guarantees survive.
- **Attestation mapping:** today's provider attestation ([tool-attestations.ts](../../../apps/web/lib/tool-attestations.ts))
  becomes "has the user authorized this Gateway target in the Identity vault?" — the gate moves but
  the UX ("connect SAP to run this") stays.
