# Tasks: AgentCore Substrate Spike

**Input**: [research.md](./research.md) · [plan.md](./plan.md)

## Phase 0: Research (done this spike)

- [x] T300 Verify AgentCore container contract, InvokeAgentRuntime API, CFN resource, and MCP TS SDK surfaces against live docs/installed types (see research.md sources).

## Phase 1: MCP in the Bedrock loop (done this spike)

- [x] T301 `packages/agent/src/mcp.ts` — `connectMcpTools` (Streamable HTTP, bearer headers, provider-prefixed tool names, error-result → throw).
- [x] T302 `BedrockRuntime.runTurn` consumes `input.mcpServers` per turn with a per-turn registry and guaranteed close; folds `firstTurnPreamble` into the system prompt.
- [x] T303 Seam updates: `types.ts` comments + `RuntimeName`/`AgentRuntime.name` unions extended with `agentcore`.
- [x] T304 Tests: loopback MCP server helper; `mcp-tools.test.ts`; `bedrock-mcp.test.ts` (scripted Bedrock client + real MCP round-trip, bearer-on-the-wire assertions).

## Phase 2: AgentCore hosting shape (code done this spike)

- [x] T305 `apps/agentcore-agent` — container speaking the AgentCore contract (`/invocations` SSE of AgentEvents, `/ping` Healthy/HealthyBusy, port 8080) reusing `runAgentLoop` + `connectMcpTools`; arm64 Dockerfile building from repo root.
- [x] T306 `AgentCoreRuntime` adapter (`InvokeAgentRuntime` SigV4, SSE → AgentEvents, threadId → runtimeSessionId with 33-char padding rule) + factory wiring (`RUNTIME=agentcore`, `AGENTCORE_RUNTIME_ARN/REGION/QUALIFIER`) + health-check branch.
- [x] T307 `AiWorkspaceAgentCoreSpikeStack` — ECR repo, execution role (image pull, Bedrock invoke, agentcore log groups), `AWS::BedrockAgentCore::Runtime` as raw CfnResource gated by `-CreateRuntime` (image-before-runtime ordering); `cdk synth` green on aws-cdk-lib 2.195.
- [x] T308 Tests: `agentcore-runtime.test.ts` (SSE chunk-boundary parsing, session-id rule, invoke error, JSON error envelope).

## Phase 3: Deploy & smoke (next session — needs AWS credentials)

- [x] T309 Deployed 2026-06-12. Step 1 ✓; the arm64 image was built **in AWS via CodeBuild** (`ai-workspace-build` with ARM_CONTAINER override) because a local proxy in Docker Desktop's path killed ECR uploads >~10MB; step 2 ✓ → runtime `ai_workspace_agent_spike-5n8RLRBVz5` READY (v1).
- [x] T310 Done 2026-06-12: managed policy in the spike stack (conditional on the runtime) attached to the deployed web + chat-worker task roles by name — the ECS stack and its services were untouched. The lane flip is now purely `RUNTIME=agentcore` + `AGENTCORE_RUNTIME_ARN=arn:aws:bedrock-agentcore:us-east-1:351478076796:runtime/ai_workspace_agent_spike-5n8RLRBVz5` on task env.
- [x] T311a Plain-turn smoke ✓ (2026-06-12): `InvokeAgentRuntime` streamed text-delta/usage/done AgentEvents over SSE (haiku-4-5, 17 in / 9 out). **Finding:** sonnet/opus Bedrock model ids in `packages/agent/models.ts` are unverified/not enabled in the account — Marketplace access error; only Haiku is enabled today (tracked in a follow-up issue).
- [x] T311b STAGED 2026-06-12: chat-worker flipped to `RUNTIME=agentcore` (rollout COMPLETED, env verified). Remaining human step: sign in, run a skill, confirm receipts + `/admin/runs` shows runtime `agentcore` + audit parity. Model access resolved via CLI (#141): Marketplace agreements created programmatically, execution role granted the `aws-marketplace:ViewSubscriptions/Subscribe` pair — **Sonnet smoke green through AgentCore**; `models.ts` ids were correct all along. Opus 4.7 is account-gated by AWS (contact-sales) — skills pinned to Opus fail on worker lanes until then.
- [x] T312 DECIDED 2026-06-12: worker lanes (durable chat, skills, scheduled) → **agentcore** (deployed); fast-local stays direct Bedrock Haiku; tool-local inline stays Cursor pending a Bedrock-MCP latency check; Cursor Cloud stays explicit opt-in. Rollback = remove two env lines on chat-worker and redeploy.

## Phase 4: Substrate adoption (follow-up spikes, separate packets)

- [ ] T313 AgentCore Identity spike — replace payload-transit GitHub tokens with managed credential injection; measure how much of `oauth_tokens`/crypto it retires.
- [ ] T314 AgentCore Gateway spike — land the next integration (Graph or Workfront) as a Gateway target instead of a bespoke MCP server.
- [ ] T315 VPC NetworkMode + scoped egress + model-ARN-scoped role before pilot traffic.
