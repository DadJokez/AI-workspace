# `@ai-workspace/mcp-servers`

**SPIKE-ONLY.** Placeholder structure for internal-system MCP servers
the Bedrock and AgentCore runtime lanes can mount.

Each file in `src/` is a stub for one external system:

| File | System | Auth model (planned) | Sample tools |
|---|---|---|---|
| [`workfront.ts`](./src/workfront.ts) | Workfront | Per-user OAuth | `search_projects`, `get_task`, `add_comment` |
| [`databricks.ts`](./src/databricks.ts) | Databricks | Service principal (M2M) | `run_sql`, `list_tables`, `describe_table` |
| [`teams.ts`](./src/teams.ts) | MS Teams | Per-user delegated Graph | `list_my_chats`, `search_messages`, `post_message` |

Each stub exports a `PlaceholderMcpServerConfig` and a `start()` placeholder that throws.
No transport, no auth, no tools — that's all promotion work.

## Why nested in one package

A spike, not a product. Three sibling packages would each need a
`package.json`, `tsconfig.json`, lint config, etc. — overhead that doesn't
buy anything yet. Promote any one of these to its own package the moment a
real implementation lands and the structure starts to fight us (probably
when the first one needs its own deps).

## Promotion checklist (per server)

1. Pick a transport: stdio (subprocess on the web container) or HTTP
   (separately deployed). Decision likely depends on the auth model —
   per-user delegated tokens push toward HTTP with auth headers.
2. Pick an MCP SDK: `@modelcontextprotocol/sdk` (TypeScript) is the
   reference implementation.
3. Implement the tool surface listed above. Each tool wires through to the
   system's API with the user's identity from the request context.
4. Wire into the MCP registry and mount through the Bedrock/AgentCore runtime
   seam with provider attestation, redaction, and audit logging.
5. Move out of this shared package once it has its own deps.

## Open architectural questions

- **Single Graph server vs. one server per Microsoft surface?** Teams,
  Mail, and Calendar all share the Entra app registration. One MCP server
  exposing all three is simpler but increases blast radius if the server
  has a bug.
- **Where do per-user tokens get injected?** `mcpServers[].env` is fixed
  at process start, so per-user delegated auth has to flow another way —
  either an HTTP server reading an `Authorization` header or a wrapper
  that re-spawns subprocesses per session.
- **Audit-log discipline.** Every tool call should land in `audit_log`.
  Keep enforcement in the MCP proxy/runtime seam so it stays provider-neutral.
