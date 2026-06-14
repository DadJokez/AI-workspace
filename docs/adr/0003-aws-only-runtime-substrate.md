# ADR 0003 - Runtime substrate: Bedrock + AgentCore, remove Cursor SDK

- **Status:** Accepted
- **Date:** 2026-06-14
- **Deciders:** Rob (PM), Codex (engineering agent)
- **Related:** [PLAN.md](../../PLAN.md), [docs/ARCHITECTURE.md](../ARCHITECTURE.md), [docs/ROADMAP.md](../ROADMAP.md), [specs/003-agentcore-substrate](../../specs/003-agentcore-substrate/)

## Context

Comparative needs to be easy to explain to enterprise buyers and IT reviewers:
the product should run through AWS Bedrock, Bedrock AgentCore, RDS, ECS/Fargate,
Secrets Manager, and the rest of the AWS governance stack. That story gets
muddy if ordinary product execution also depends on the Cursor SDK, Cursor
Cloud, Anysphere credentials, and Cursor-side provider run state.

Cursor remains valuable as a standalone desktop IDE for hardcore development
work. Comparative has a different center of gravity: chat with work context,
tools, skills, schedules, small apps, sharing, audit, and governance for
business users. The runtime should stay in the simplest lane that can satisfy
the ask, and should escalate to durable AWS infrastructure only when the ask
requires it.

Before this ADR, the codebase had three runtime ideas at once:

- direct Bedrock for fast chat experiments;
- Bedrock AgentCore for durable worker lanes;
- Cursor SDK / Cursor Cloud for agent/tool/code execution and cloud recovery.

That increased latency, confused the product pitch, expanded the dependency
and secrets surface, and made "where did this transcript go?" harder to answer.

## Decision

Remove Cursor SDK from the Comparative product runtime and standardize on an
AWS-only runtime substrate:

1. **Fast chat:** direct Bedrock streaming through `BedrockRuntime`.
2. **Interactive tool chat:** Bedrock plus mounted MCP tools through the same
   runtime seam.
3. **Durable work:** Bedrock AgentCore through `AgentCoreRuntime`, claimed by
   the worker lane for long-running chat, skills, schedules, and future app
   build/deploy work.
4. **Runtime package:** rename the runtime seam from
   `@ai-workspace/cursor-runtime` to `@ai-workspace/agent-runtime`.
5. **Legacy cloud mode:** remove the UI cloud toggle and treat old
   `executionMode: "cloud"` request payloads as local. This keeps older clients
   harmless without preserving a dead provider path.
6. **Secrets/config:** remove Cursor API keys and Cursor Cloud config from app
   env, Docker, CDK task definitions, and model listing.

The runtime contract remains `AgentRuntime`. The app should not depend on a
specific provider SDK above that seam.

## Consequences

**Positive**

- The enterprise story is simpler: product execution stays inside AWS runtime,
  AWS IAM, AWS secrets, AWS logs, and AWS networking.
- No ordinary chat/tool/skill transcript is sent to Anysphere by Comparative.
- The dependency and vulnerability surface shrinks by removing `@cursor/sdk`
  and its transitive tree.
- The UI no longer asks users to understand a cloud toggle. Routing is
  automatic: fast when possible, durable when necessary.
- The same Bedrock MCP loop powers fast tool turns and AgentCore durable turns,
  so tool access behaves more consistently.

**Negative / risks**

- We lose Cursor Cloud's provider-side run recovery, cancellation, and IDE-like
  code-agent features inside Comparative.
- We lose Cursor model listing as a dynamic source of model options; model
  choices now come from our Bedrock-backed registry.
- AgentCore becomes the critical durable-execution substrate, so AWS model
  access, AgentCore availability, IAM policy, and runtime observability matter
  more.
- If future app-build work needs deep IDE semantics, Comparative must either
  build that on AWS-native primitives or deliberately re-open the external
  coding-agent question.

## Alternatives considered

- **Keep Cursor as an explicit optional lane.** Rejected for now. Even an
  optional lane complicates compliance language, secrets, docs, recovery paths,
  user mental model, and test coverage. Cursor desktop remains available
  outside Comparative for users who need that class of tooling.
- **Keep Cursor only for durable code work.** Rejected for the same reason:
  app/code generation is exactly the path enterprise reviewers will ask about.
  If Comparative builds and deploys business apps, that execution should be
  inside the governed AWS stack.
- **Remove AgentCore and use only direct Bedrock.** Rejected. Direct Bedrock is
  the right fast lane, but schedules, skills, long-running jobs, and future
  app-build flows need worker isolation, retry/reconnect semantics, and runtime
  ownership beyond a browser request.
- **Build a full custom orchestration framework now.** Rejected. The seam lets
  us use Bedrock and AgentCore today while delaying heavier orchestration until
  measured product needs force it.

## Revisit when

Re-open this decision only if one of these becomes true:

- AgentCore cannot support required durable execution semantics after a real
  production spike, and no AWS-native substitute is acceptable.
- A specific enterprise customer approves and requires an external coding-agent
  runtime for a clearly scoped workflow.
- AWS model access, latency, or cost becomes materially worse than an external
  runtime for Comparative's core workflows.
- Future app-build/deploy work proves it needs IDE-grade repo editing semantics
  that cannot reasonably be built on Bedrock, AgentCore, GitHub, and the deploy
  controller.
