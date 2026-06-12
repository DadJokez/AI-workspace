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

- [ ] T309 Deploy stack step 1 (repo + role); build & push the arm64 image; deploy step 2 (`--parameters CreateRuntime=true`). Follow plan.md runbook.
- [ ] T310 Grant `bedrock-agentcore:InvokeAgentRuntime` on the runtime ARN to the web/chat-worker task roles.
- [ ] T311 Smoke: plain turn, Developer Briefing skill run (GitHub MCP from inside AgentCore), `/api/health`, audit/run_events parity. Record cold-start + cost observations in plan.md.
- [ ] T312 Decide lane defaults: Runtime V2 tool lane → bedrock (Layer 1) now; durable/skill lanes → agentcore after smoke.

## Phase 4: Substrate adoption (follow-up spikes, separate packets)

- [ ] T313 AgentCore Identity spike — replace payload-transit GitHub tokens with managed credential injection; measure how much of `oauth_tokens`/crypto it retires.
- [ ] T314 AgentCore Gateway spike — land the next integration (Graph or Workfront) as a Gateway target instead of a bespoke MCP server.
- [ ] T315 VPC NetworkMode + scoped egress + model-ARN-scoped role before pilot traffic.
