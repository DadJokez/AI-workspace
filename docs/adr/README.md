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
| [0006](./0006-model-decided-tool-routing.md) | Sonnet 4.6 decides when interactive chat needs tools | Accepted |
| [0007](./0007-single-execution-ledger.md) | `runs` + `run_events` as the single execution ledger | Accepted |
| [0008](./0008-handwritten-sql-migrations.md) | Handwritten SQL migrations over `drizzle-kit generate` | Accepted |
| [0009](./0009-progressive-tool-discovery.md) | Progressive tool discovery via stable bundles (succeeds 0006) | Accepted |
| [0010](./0010-prompt-cache-discipline.md) | Prompt-cache discipline: stable prefix / volatile suffix / pinned layer | Accepted |
| [0011](./0011-tool-policy-observe-before-enforce.md) | Tri-state tool policy, observe before enforce | Accepted — amended 2026-09-02 (enforcement landed, #831–#835) |
| [0012](./0012-two-execution-lanes.md) | Two execution lanes (inline + durable worker) | Accepted — mechanism under revision ([#442](https://github.com/DadJokez/AI-workspace/issues/442)) |
| [0013](./0013-durable-conversation-resources.md) | Uploaded files are durable, thread-scoped conversation resources | Accepted |
| [0014](./0014-tamper-evident-audit-log.md) | Tamper-evident `audit_log` via a per-row hash chain | Proposed — design only ([#457](https://github.com/DadJokez/AI-workspace/issues/457)) |

0007–0012 were added 2026-07-19, promoting shipped decisions that had lived
only in specs/memory (prompted by the [self-review](../reviews/REPO-SELF-REVIEW-2026-07-19.md)
and the [hardening epic #453](https://github.com/DadJokez/AI-workspace/issues/453)).

New ADR: copy the format of 0001 (Context → Decision → Consequences →
Alternatives → Revisit when), number it sequentially, and add a row here.
