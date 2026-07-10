# Architecture Decision Records

Short, durable records of significant architecture decisions — the *why*
behind choices that are expensive to reverse, written so a future reader (or
an IT reviewer) understands the reasoning without archaeology.

| ADR | Title | Status |
|---|---|---|
| [0001](./0001-context-knowledge-management.md) | Context & Knowledge Management: curated-context-first, defer the vector DB | Accepted |
| [0002](./0002-skill-format.md) | Skill format: database rows at runtime, SKILL.md for portability | Accepted |
| [0003](./0003-aws-only-runtime-substrate.md) | Runtime substrate: Bedrock + AgentCore, remove Cursor SDK | Accepted |
| [0004](./0004-agentcore-gateway-integration-pattern.md) | AgentCore Gateway integration pattern | Proposed |
| [0005](./0005-google-shared-mcp-facade.md) | Google alpha uses one shared governed MCP facade | Accepted |

New ADR: copy the format of 0001 (Context → Decision → Consequences →
Alternatives → Revisit when), number it sequentially, and add a row here.
