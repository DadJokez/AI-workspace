# Plan: AgentCore Substrate Spike

**Branch**: `spike/agentcore-substrate` | **Date**: 2026-06-12 | **Research**: [research.md](./research.md)

## Why (decision record)

The enterprise runtime answer is AWS (the enterprise already runs Bedrock; "AWS-managed" reads better than hand-rolled in the coming IT review), while Cursor stays the innovation lane. Two gaps stood between AI Hub and that posture:

1. **The Bedrock lane had no MCP client** — `TurnInput.mcpServers` was documented as "Bedrock ignores", violating the repo's own "all tools must be MCP servers" constitution and leaving every tool turn dependent on Anysphere.
2. **No AWS-managed hosting shape for the loop** — durable/tool work had no substrate story other than Cursor Cloud.

This spike closes both behind the existing `AgentRuntime` seam, which exists precisely so this swap is an env-var, not a rewrite.

## What was built

```
Layer 1 — MCP in the loop (runs everywhere, fully tested)
  packages/agent/src/mcp.ts            connectMcpTools(): Streamable-HTTP MCP client →
                                       Tool[] for the existing ToolRegistry/runAgentLoop
  packages/cursor-runtime/
    bedrock-runtime.ts                 consumes input.mcpServers per turn (provider-prefixed
                                       tools, per-user bearer headers, close after turn);
                                       folds firstTurnPreamble into the system prompt

Layer 2 — AgentCore hosting shape (code + IaC complete; deploy = runbook below)
  apps/agentcore-agent/                the SAME loop relocated into a container speaking the
                                       AgentCore contract: POST /invocations (SSE of
                                       AgentEvents), GET /ping, port 8080, arm64
  packages/cursor-runtime/
    agentcore-runtime.ts               AgentRuntime adapter: TurnInput → InvokeAgentRuntime
                                       (SigV4) → SSE → AgentEvents; threadId = runtimeSessionId
    factory.ts                         RUNTIME=agentcore (+ AGENTCORE_RUNTIME_ARN/REGION/QUALIFIER)
  infra/cdk/lib/ai-workspace-agentcore-spike-stack.ts
                                       ECR repo + execution role + AWS::BedrockAgentCore::Runtime
                                       (raw CfnResource), gated by -CreateRuntime to solve the
                                       image-before-runtime ordering
```

**Event vocabulary is unchanged** — every lane (cursor, bedrock, agentcore) emits the same `AgentEvent`s, so chat SSE relay, run_events, activity timeline, audit, and artifacts work untouched. Skills (specs/002) run on any lane for free.

## Trust model

- Shell → AgentCore: SigV4 (`bedrock-agentcore:InvokeAgentRuntime`) from the service role. No new secrets.
- Per-user MCP bearer tokens ride inside the invoke payload over TLS — the **same transit trust** as Cursor mounts today, but the receiving side is now a session-isolated container in *our* AWS account instead of Anysphere's cloud. Tokens are per-turn and short-lived; they are never logged or persisted container-side.
- Container egress (spike): `NetworkMode: PUBLIC` to reach Bedrock + `api.githubcopilot.com`. Before pilot: VPC mode + scoped egress, and model ARNs instead of `*` in the role.

## Deploy & verify runbook (next session, needs AWS creds)

```bash
# 1. Repo + role (runtime not created yet)
pnpm --filter @ai-workspace/infra cdk deploy AiWorkspaceAgentCoreSpikeStack

# 2. Build & push the arm64 agent image (from repo root)
aws ecr get-login-password | docker login --username AWS --password-stdin <account>.dkr.ecr.<region>.amazonaws.com
docker buildx build --platform linux/arm64 -f apps/agentcore-agent/Dockerfile \
  -t <AgentImageRepoUri>:latest --push .

# 3. Create the runtime
pnpm --filter @ai-workspace/infra cdk deploy AiWorkspaceAgentCoreSpikeStack --parameters CreateRuntime=true
# → output AgentRuntimeArn

# 4. Point a lane at it (web or chat-worker task env)
RUNTIME=agentcore AGENTCORE_RUNTIME_ARN=<arn>

# 5. Smoke (the spike's exit criteria)
#    a. plain chat turn streams text            (fast path through the container)
#    b. Developer Briefing skill run            (GitHub MCP tools from inside AgentCore)
#    c. /api/health shows runtime agentcore ok
#    d. audit rows + run_events identical in shape to bedrock/cursor runs
# 6. Grant the caller role bedrock-agentcore:InvokeAgentRuntime on the runtime ARN
#    (attach to ai-workspace web/chat-worker task roles — one PolicyStatement).
```

Local pre-flight without AWS: `pnpm --filter @ai-workspace/agentcore-agent dev` then
`curl -s localhost:8080/ping` and POST a turn to `/invocations` with `BEDROCK_CLIENT=fake`.

## Adoption sequence (after the smoke passes)

1. **Now**: `RUNTIME_V2` tool lane can target `bedrock` (Layer 1) — tool turns without Anysphere, no deploy dependency.
2. **Pilot posture**: durable/skill lanes target `agentcore`; Cursor remains explicit opt-in (the innovation lane).
3. **Identity spike**: move per-user GitHub tokens from payload transit into AgentCore Identity / Gateway credential injection → deletes custom crypto from the review surface.
4. **Gateway spike**: next integration (Graph/Workfront) lands as a Gateway target instead of a bespoke MCP server.

## Open questions

- AgentCore Runtime cold-start and per-session pricing at pilot volume (measure during smoke; compare against the always-on chat-worker).
- VPC `NetworkMode` + PrivateLink posture before any enterprise data classification above public.
- Whether the chat-worker keeps claiming runs and *calling* AgentCore (current design — worker stays the lease/ledger owner) or schedules move into AgentCore's async jobs later. Current answer: worker stays; AgentCore is execution substrate only.
