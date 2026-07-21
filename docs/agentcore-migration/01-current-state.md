# 01 — Current State of Comparative (pre-AgentCore-Harness)

> Discovery report for the AgentCore Harness migration. Every claim cites `file:line` so it can
> be spot-checked. Scope: the `ai-workspace` monorepo (product **Comparative**, formerly "AI Hub").

## Assumptions

- "Comparative" = "AI Hub" = this `ai-workspace` repo; enterprise deployment target is **the enterprise**.
- Reference facts about AgentCore Harness are taken from the GA docs fetched 2026-06-18 (see
  [02-target-architecture.md](02-target-architecture.md) for the citations); where the docs
  contradict prior knowledge, the docs win.
- Line numbers are from the working tree at discovery time (branch `main`, ~commit `aa10d82`).
  Treat them as ±a few lines if the file has since changed.

## TL;DR — the one thing to understand first

The mission framing ("we hand-roll our agent loop in Fargate") is **half the picture**. Comparative
already runs a **two-runtime** architecture behind a clean seam:

| Lane | Trigger | Runtime today | Where the loop runs |
|---|---|---|---|
| **Fast chat** (`fast-local` / `direct-chat`) | default | **Bedrock** (`ConverseStream`) | hand-rolled loop, in-process in `apps/web` |
| **Tool chat** (`tool-local` / `bedrock-agent`) | GitHub/Notion/tool intent | **Bedrock** + mounted MCP | hand-rolled loop, in-process in `apps/web` |
| **Durable / skill / scheduled** (`durable-local` / `agentcore-worker`) | "implement/build/deploy", schedules | **AgentCore *Runtime*** (custom-code container) | **same hand-rolled loop**, hosted in `apps/agentcore-agent` |

The selector is one env var (`RUNTIME=bedrock|agentcore`) behind the `AgentRuntime` interface
([packages/agent-runtime/src/factory.ts:23](../../packages/agent-runtime/src/factory.ts),
[types.ts](../../packages/agent-runtime/src/types.ts)). Critically, **AgentCore Runtime here is NOT
the managed Harness** — it is a thin arm64 container ([apps/agentcore-agent/src/server.ts](../../apps/agentcore-agent/src/server.ts))
that runs the *same* `runAgentLoop()` we wrote. So the migration question is a **three-way
convergence**: collapse (a) the in-process Bedrock loop and (b) the custom-code Runtime container
onto (c) the managed Harness loop. This was decided incrementally across
[specs/001-004](../../specs/) and [adr/0003-aws-only-runtime-substrate.md](../adr/0003-aws-only-runtime-substrate.md);
the docs in this folder must extend those decisions, not relitigate them.

---

## 1. Repo topology

pnpm monorepo, root [package.json](../../package.json) (`name: ai-workspace`, pnpm 9.12.3, Node ≥20).

```
apps/
  web/                Next.js App Router — the product (UI, API routes, orchestration glue)
  agentcore-agent/    arm64 container that hosts the agent loop on AgentCore Runtime
packages/
  agent/              the agent loop, tool registry, Bedrock client, MCP client, model registry
  agent-runtime/      runtime seam: AgentRuntime interface + Bedrock & AgentCore adapters + factory
  auth/               shared auth types (SessionUser, UserRole)
  db/                 Drizzle schema + migrations (RDS Postgres)
  evals/              eval harness (LLM-judge + assertions), transcript replay
  mcp-servers/        MCP server specs (databricks, teams, workfront — placeholders)
infra/cdk/            AWS CDK: ECS stack, AgentCore spike stack, runtime-v2 preview stack
specs/                001-runtime-v2-autopilot … 005-onboarding-wizard (spec-driven dev)
docs/                 architecture, ADRs, roadmap, enterprise-readiness
buildspec.yml         CodeBuild → ECR build + forced ECS deploy (prod)
buildspec.runtime-v2.yml   same for the runtime-v2 preview cluster
```

Key entry points:
- Next.js routes: [apps/web/app/api/](../../apps/web/app/) (chat, auth, oauth, mcp, apps, health…).
- "Fargate workers": the ECS *services* are `web`, `chat-worker`, `memory-worker`
  ([infra/cdk/lib/ai-workspace-ecs-stack.ts](../../infra/cdk/lib/ai-workspace-ecs-stack.ts)); the
  worker *logic* is `runChatRunWorkerLoop` ([apps/web/lib/chat-run-worker.ts:152](../../apps/web/lib/chat-run-worker.ts))
  and the memory worker ([apps/web/lib/memory-capture.ts](../../apps/web/lib/memory-capture.ts)).

## 2. The agent loop today

**Core loop:** `runAgentLoop()` — an async generator implementing model-call → tool-select →
execute → feed-results, bounded by `maxToolIterations` (default 8).
[packages/agent/src/loop.ts:40](../../packages/agent/src/loop.ts) (loop body ~69–182).

- The system prompt is grounded with a live UTC timestamp + model identity each turn
  ([loop.ts:47](../../packages/agent/src/loop.ts)) — this is the date/identity-honesty spine.
- Model call is **streaming**: `client.converseStream()` ([loop.ts:75](../../packages/agent/src/loop.ts)),
  events normalized to a `BedrockStreamEvent` union (text-delta / tool-use / usage / stop)
  ([packages/agent/src/clients.ts:23](../../packages/agent/src/clients.ts)).
- Tool calls accumulate during the stream and execute when `stopReason === "tool_use"`
  ([loop.ts:129](../../packages/agent/src/loop.ts)); results feed back as a user-role `tool-result`
  block ([loop.ts:177](../../packages/agent/src/loop.ts)). Tool errors are caught and returned to
  the model as error results ([loop.ts:163](../../packages/agent/src/loop.ts)).
- Emits an `AgentEvent` stream (`text-delta`, `tool-call`, `tool-result`, `usage`, `error`, `done`)
  — see the union in [packages/agent/src/types.ts](../../packages/agent/src/types.ts).

**Tool registration:** in-memory `ToolRegistry` per turn
([packages/agent/src/registry.ts:10](../../packages/agent/src/registry.ts)). `register()` rejects
duplicate names; `toBedrockToolConfig()` emits Bedrock's `{toolSpec:{name,description,inputSchema:{json}}}`
shape ([registry.ts:56](../../packages/agent/src/registry.ts)). `normalizeToolInputSchema()` defaults
malformed schemas to `{type:object, properties:{}}` ([registry.ts:68](../../packages/agent/src/registry.ts)).
Allowlist filtering via `list(allowed?)`; empty list ⇒ `toolConfig` omitted entirely.

**Streaming/SSE:** server emits `data: ${JSON.stringify(event)}\n\n` frames; the browser parses
them with `readSseStream<T>()` ([apps/web/lib/sse.ts:7](../../apps/web/lib/sse.ts)). The inline
runner forwards each `AgentEvent` to a `send()` callback ([apps/web/lib/chat-inline-runner.ts](../../apps/web/lib/chat-inline-runner.ts)).

**Runtime seam (the migration-critical part):**
- `getRuntime()` resolves `RUNTIME` (default `bedrock`) → `BedrockRuntime` or `AgentCoreRuntime`
  ([packages/agent-runtime/src/factory.ts:23](../../packages/agent-runtime/src/factory.ts)).
  AgentCore requires `AGENTCORE_RUNTIME_ARN`; optional `AGENTCORE_REGION`, `AGENTCORE_QUALIFIER`.
- `BedrockRuntime.runTurn()` builds a per-turn registry, connects HTTP MCP servers, runs
  `runAgentLoop()` ([packages/agent-runtime/src/bedrock-runtime.ts:40](../../packages/agent-runtime/src/bedrock-runtime.ts)).
- `AgentCoreRuntime.runTurn()` derives a `runtimeSessionId` from `threadId`, packages
  `{threadId, modelId, systemPrompt, messages, mcpServers, builtinTools, userId}` as JSON, and calls
  **`InvokeAgentRuntimeCommand`** with `accept: text/event-stream`, then parses the SSE back into
  `AgentEvent`s ([packages/agent-runtime/src/agentcore-runtime.ts:48](../../packages/agent-runtime/src/agentcore-runtime.ts)).
- The hosted container implements the AgentCore Runtime contract: `GET /ping` →
  `{status:"Healthy"|"HealthyBusy"}`, `POST /invocations` → SSE; arm64, port 8080
  ([apps/agentcore-agent/src/server.ts:8](../../apps/agentcore-agent/src/server.ts)). It calls the
  **same** `runAgentLoop()` ([apps/agentcore-agent/src/handler.ts:115](../../apps/agentcore-agent/src/handler.ts)).

**Routing:** `chat-routing.ts` is deterministic keyword matching into three lanes (durable / tool /
fast), persisted on the run ([apps/web/lib/chat-routing.ts:74](../../apps/web/lib/chat-routing.ts)).
Worker runs default to `runtimeTarget:"agentcore-worker"` and pick AgentCore iff `AGENTCORE_RUNTIME_ARN`
is set ([chat-run-worker.ts:1096](../../apps/web/lib/chat-run-worker.ts)).

## 3. Bedrock integration

- **Models** (all cross-region inference profiles, `us.` prefix) — registry at
  [packages/agent/src/models.ts:36](../../packages/agent/src/models.ts):
  | App id | Bedrock model id | ctx / max-out | notes |
  |---|---|---|---|
  | `haiku-4-5` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | 200K / 4096 | cheap-ops / autopilot-simple |
  | `sonnet-4-6` | `us.anthropic.claude-sonnet-4-6` | 200K / 8192 | **default** |
  | `opus-4-7` | `us.anthropic.claude-opus-4-7` | 200K / 8192 | heavy reasoning |
  Single-region deploy would drop the `us.` prefix ([models.ts:6](../../packages/agent/src/models.ts)).
- **Invocation pattern:** `ConverseStreamCommand` from `@aws-sdk/client-bedrock-runtime`
  ([packages/agent/src/clients.ts:206](../../packages/agent/src/clients.ts)) — **Converse API, streaming**,
  not `InvokeModel`. `system`, `messages`, `toolConfig`, `inferenceConfig.maxTokens` are passed.
- **Region:** `AWS_REGION` / `AWS_DEFAULT_REGION` ([clients.ts:159](../../packages/agent/src/clients.ts)); prod is `us-east-1`.
- **Real vs fake client:** `BEDROCK_CLIENT=fake` (default, echoes input for local dev) vs `real`
  ([clients.ts:296](../../packages/agent/src/clients.ts)); prod sets `real`.
- **Model "autopilot":** heuristic (regex + word-count), no extra model call
  ([apps/web/lib/runtime-model-policy.ts:32](../../apps/web/lib/runtime-model-policy.ts)). `RUNTIME_V2_DIRECT_MODEL_ID=auto`
  ⇒ Haiku for ≤8-word/simple turns, Sonnet for writing/reasoning, default Sonnet. Spec:
  [specs/001-runtime-v2-autopilot/spec.md](../../specs/001-runtime-v2-autopilot/spec.md).

## 4. Identity & auth

- **Sign-in IdP today:** NextAuth v4, **GitHub OAuth only** (POC)
  ([apps/web/lib/auth/nextauth.ts:36](../../apps/web/lib/auth/nextauth.ts)). JWT strategy, no DB adapter.
- **Enterprise IdP (required before enterprise production): PingOne / PingFederate OIDC.** The schema is
  pre-shaped for it: the external subject lives in `users.ping_subject`
  ([packages/db/src/schema.ts:111](../../packages/db/src/schema.ts), comment at
  [schema.ts:19](../../packages/db/src/schema.ts)). The swap is a **single NextAuth provider config
  change — no DB migration** ([docs/ARCHITECTURE.md:124](../ARCHITECTURE.md),
  [PLAN.md:81](../../PLAN.md), [README.md:14](../../README.md),
  [COMPARATIVE_ARCHITECTURE_OVERVIEW.md:190](../COMPARATIVE_ARCHITECTURE_OVERVIEW.md)).
- **Session/JWT claims:** `userId`, `role`, `email`, `displayName`, `ghSub`
  ([nextauth.ts:114](../../apps/web/lib/auth/nextauth.ts)); typed at
  [apps/web/types/next-auth.d.ts](../../apps/web/types/next-auth.d.ts) and
  [packages/auth/src/types.ts:34](../../packages/auth/src/types.ts).
- **Sign-in gate:** first-ever user (empty table) or existing user or email with pending invitation;
  random GitHub users rejected ([nextauth.ts:62](../../apps/web/lib/auth/nextauth.ts)). First user → `admin`.
- **Authorization scoping:** `userScope(user, column)` returns `eq(column, user.id)` for non-admins,
  `undefined` (no filter) for admins ([apps/web/lib/auth/scope.ts:16](../../apps/web/lib/auth/scope.ts)).
  This is the cross-user data-isolation primitive (read side). The `users.id` UUID is the universal
  scoping key for every per-user row.
- **Per-user connector credentials (independent of sign-in IdP):** GitHub/Notion (Google scaffolded)
  OAuth tokens in `oauth_tokens`, **AES-256-GCM encrypted at rest** with `OAUTH_ENCRYPTION_KEY`
  ([apps/web/lib/oauth/crypto.ts:9](../../apps/web/lib/oauth/crypto.ts)), unique on `(user_id, provider)`
  ([packages/db/src/schema.ts:243](../../packages/db/src/schema.ts)). Decryption happens in the web
  process; the token rides as a `Bearer` header into the MCP call. Shared skills/apps re-gate on the
  **executing** user's own tokens — credentials never escalate ([docs/ARCHITECTURE.md:134](../ARCHITECTURE.md)).

## 5. Tools / integrations

The agent reaches external systems exclusively as **MCP tools** (name format `provider__tool`,
[packages/agent/src/mcp.ts:49](../../packages/agent/src/mcp.ts)). Per-turn HTTP MCP connection via
`connectMcpTools()` ([mcp.ts:60](../../packages/agent/src/mcp.ts)); per-user servers assembled in
[apps/web/lib/oauth/mcp-servers.ts:167](../../apps/web/lib/oauth/mcp-servers.ts).

| Integration | Status | Transport / endpoint | Auth | Schema/spec location |
|---|---|---|---|---|
| **GitHub** | shipped | remote MCP `https://api.githubcopilot.com/mcp/` | per-user OAuth bearer (`repo read:user`) | external (GitHub-hosted) |
| **Notion** | shipped | **same-origin relay** `POST /api/mcp/notion` (HMAC `X-Comparative-MCP-Relay`) | per-user OAuth bearer | [apps/web/lib/notion/mcp.ts](../../apps/web/lib/notion/mcp.ts), [route.ts](../../apps/web/app/api/mcp/notion/route.ts) |
| **Databricks** | **placeholder** | TBD | service-principal OAuth (M2M), userId as audit tag | [packages/mcp-servers/src/databricks.ts](../../packages/mcp-servers/src/databricks.ts) |
| **MS Teams** | **placeholder** | TBD (Graph) | per-user delegated Graph token (Entra app reg) | [packages/mcp-servers/src/teams.ts](../../packages/mcp-servers/src/teams.ts) |
| **Workfront** | **placeholder** | TBD | TBD | [packages/mcp-servers/src/workfront.ts](../../packages/mcp-servers/src/workfront.ts) |
| **web fetch** | shipped | built-in tool (no MCP) | n/a | [packages/agent/src/web-fetch-tool.ts](../../packages/agent/src/web-fetch-tool.ts) |

Roadmap placeholders (not built): M365 Graph (mail/cal/files), Salesforce, ServiceNow, **SAP ERP
(FI — the "SAP Budget Query" wedge)**, data-lake, agent-authored Databricks notebooks
([docs/ROADMAP.md:190](../ROADMAP.md), 220-221). The mission's Qlik/SAP-HANA examples are
illustrative only — they don't exist in-repo.

**Tool governance / honesty layer (Comparative-specific, a product differentiator):**
- Attestation gating: a provider must be user-approved before its tools mount
  ([apps/web/lib/tool-attestations.ts](../../apps/web/lib/tool-attestations.ts),
  [agent-preamble.ts:147](../../apps/web/lib/agent-preamble.ts)); blocked providers produce a
  "connect X to run this" message, never a silent hallucination.
- Audit: every call/result pair → redacted `auditLog` row + `run_events`
  ([apps/web/lib/audit-tool-events.ts:43](../../apps/web/lib/audit-tool-events.ts),
  [run-events.ts](../../apps/web/lib/run-events.ts)).
- Preamble steers honesty: distinguishes real tool calls from UI suggestions, states the live date,
  states which model it is, lists which tools are actually mounted
  ([apps/web/lib/agent-preamble.ts:54](../../apps/web/lib/agent-preamble.ts)).

## 6. RAG / Knowledge

**There is no RAG plumbing today — by deliberate decision.** Knowledge is *context-packed per turn*,
not retrieved.

- No vector store, no embedding model, no chunking, no Bedrock Knowledge Bases anywhere in the code.
  pgvector + Bedrock KB are explicitly **held in reserve** ([docs/adr/0001-context-knowledge-management.md](../adr/0001-context-knowledge-management.md),
  [docs/KNOWLEDGE_MANAGEMENT.md](../KNOWLEDGE_MANAGEMENT.md)).
- Context is assembled by `buildChatContextPack()` from: user custom instructions + approved Vault
  memory + uploaded file artifacts + connected-tool manifests, injected into the system prompt
  ([apps/web/lib/chat-context-pack.ts:184](../../apps/web/lib/chat-context-pack.ts)). A
  `ChatContextReceipt` records exactly what was injected and why ([chat-context-pack.ts:88](../../apps/web/lib/chat-context-pack.ts)).
- Planned escalation: Phase 2 = pgvector in the existing RDS + a Bedrock embeddings model, project-
  scoped; Phase 3 = MCP-against-source first, Bedrock KB only if a unified cross-project index is
  proven necessary (ADR 0001).

## 7. Memory / state

Stateless model (full history re-sent each turn); all state durable in RDS Postgres (Drizzle,
[packages/db/src/schema.ts](../../packages/db/src/schema.ts)).

| Table | Purpose | Key columns |
|---|---|---|
| `chat_threads` | conversation container | `id`, `userId`, `title`, `defaultModelId`, `summary`, `summaryUpdatedAt` |
| `chat_messages` | turn history | `threadId`, `role`, `content`, `modelId`, `runtime`, `tokensIn/Out`, `toolCalls` (jsonb), `toolResults` (jsonb) |
| `runs` | universal run ledger (chat + skill + scheduled) | `userId`, `skillId?`, `threadId?`, `status`, `runtime`, `modelId`, `inputs`/`outputs` (jsonb), timings |
| `run_events` | append-only per-run event stream | `runId`, `sequence`, `eventType`, `toolName`, `input`/`output` (redacted) |
| `memory_capture_queue` | windows awaiting memory extraction | `userId`, `threadId`, `from/toMessageId`, `status`, `attemptCount` |
| `user_memory_items` | "Vault" long-term memory | `userId`, `status` (suggested/approved/…), `category`, `title`, `bodyMd`, `confidence`, `sourceMessageIds` |
| `oauth_tokens` | per-user connector creds (encrypted) | `userId`, `provider`, `accessToken`, `refreshToken`, `expiresAt`, `scope` |

- **Across turns:** reload `chat_messages` ordered by `createdAt`, re-send to Bedrock; persist the
  assistant message + token counts + tool calls/results.
- **Rolling summary:** `chat_threads.summary` exists to bound history replay
  ([schema.ts:180](../../packages/db/src/schema.ts)); generation still pending per ROADMAP.
- **Vault (long-term):** background "memory worker" claims `memory_capture_queue` (poll ~20m, batch 40),
  builds a per-user review doc, asks `MEMORY_CAPTURE_MODEL_ID` (default Sonnet) to extract suggestions,
  writes `user_memory_items` as `suggested`; user approves → injected into future turns
  ([apps/web/lib/memory-capture.ts:70](../../apps/web/lib/memory-capture.ts), 141, 371).
- **Retention:** no TTL columns; an `audit:retention` script handles cleanup out-of-band
  ([package.json](../../package.json) `audit:retention`).

## 8. Observability

- **Logs:** CloudWatch log groups per service, **1-month retention**:
  `/ecs/ai-workspace/{web,chat-worker,memory-worker}` (RETAIN)
  ([infra/cdk/lib/ai-workspace-ecs-stack.ts:158](../../infra/cdk/lib/ai-workspace-ecs-stack.ts));
  runtime-v2 mirrors with DESTROY policy. AgentCore writes to `/aws/bedrock-agentcore/*` via role policy
  ([ai-workspace-agentcore-spike-stack.ts:68](../../infra/cdk/lib/ai-workspace-agentcore-spike-stack.ts)).
- **Container Insights v2** enabled on both clusters ([ecs-stack.ts:101](../../infra/cdk/lib/ai-workspace-ecs-stack.ts)).
- **Alarms:** only `*-web-unhealthy-hosts` (≥1 unhealthy host, 3×1min)
  ([ecs-stack.ts:306](../../infra/cdk/lib/ai-workspace-ecs-stack.ts)).
- **App-level telemetry:** `run_events` rows (redacted) + an admin `RuntimeV2Report` with per-lane
  first-token latency p50/p95 and failure groups ([apps/web/lib/admin/run-reporting.ts:36](../../apps/web/lib/admin/run-reporting.ts)).
- **Gaps (material for the migration):** no distributed tracing (no X-Ray/OTel), no structured JSON
  logs, **no per-model token/cost metric**, no trace correlation across web → AgentCore. This is
  exactly the gap AgentCore GenAI Observability is meant to close (see [specs/observability-spec.md](specs/observability-spec.md)).

## 9. Guardrails

| Layer | Status | Evidence |
|---|---|---|
| Prompt-injection framing | ✅ shipped | nonce-delimited untrusted content: per-call UUID markers, literal-marker stripping, "treat as DATA" instruction ([apps/web/lib/artifact-context.ts:157](../../apps/web/lib/artifact-context.ts)) |
| Secret/PII redaction | ✅ shipped | key-name regex + bearer/ghp_/sk-/PEM patterns, length/depth caps, applied before **all** persistence ([apps/web/lib/tool-redaction.ts:13](../../apps/web/lib/tool-redaction.ts)) |
| Provider attestation | ✅ shipped | tools won't mount without explicit user approval ([tool-attestations.ts](../../apps/web/lib/tool-attestations.ts)) |
| Capability honesty | ✅ shipped | preamble forbids claiming unmounted tools / fabricating results ([agent-preamble.ts:54](../../apps/web/lib/agent-preamble.ts)) |
| Bedrock Guardrails | ❌ not configured | no Guardrail resource in CDK or invocation path |
| Classifier-based PII / denied topics | ❌ not present | redaction is pattern-based only |

## 10. Deployment infra

- **IaC:** AWS CDK ([infra/cdk/bin/ai-workspace.ts](../../infra/cdk/bin/ai-workspace.ts)), three stacks,
  **account `<AWS_ACCOUNT_ID>`, region `us-east-1`**:
  1. `AiWorkspaceEcsStack` — cluster `ai-workspace-prod`; 3 Fargate services: **web** (512 CPU / 1024 MiB,
     desired 1), **chat-worker** (256 / 512), **memory-worker** (256 / 512); ALB; Secrets Manager
     `ai-workspace/production/app` (`DATABASE_URL`, `NEXTAUTH_SECRET`, GitHub/Notion OAuth, `OAUTH_ENCRYPTION_KEY`);
     imports pre-existing RDS via SG `sg-019e87b5938a295a4`. **chat-worker runs `RUNTIME=agentcore`
     with `AGENTCORE_RUNTIME_ARN=…runtime/ai_workspace_agent_spike-…`** ([ecs-stack.ts:264](../../infra/cdk/lib/ai-workspace-ecs-stack.ts)).
  2. `AiWorkspaceAgentCoreSpikeStack` — ECR repo `ai-workspace-agentcore-agent`, execution role
     (`bedrock-agentcore.amazonaws.com`), and the `AWS::BedrockAgentCore::Runtime` CfnResource
     `ai_workspace_agent_spike`, **NetworkMode PUBLIC**, gated behind `CreateRuntime` param
     ([ai-workspace-agentcore-spike-stack.ts:84](../../infra/cdk/lib/ai-workspace-agentcore-spike-stack.ts)).
  3. `AiWorkspaceRuntimeV2PreviewStack` — a parallel staging cluster, model pinned to `haiku-4-5`.
- **⚠ Landmines (confirmed):** all tasks run in the **default VPC's PUBLIC subnets** with
  `assignPublicIp=true` ([ecs-stack.ts:212](../../infra/cdk/lib/ai-workspace-ecs-stack.ts);
  [cdk.context.json](../../infra/cdk/cdk.context.json)). AgentCore spike is **NetworkMode PUBLIC** and
  its Bedrock IAM is `resources:["*"]` — both flagged "tighten before pilot" in
  [specs/003-agentcore-substrate/plan.md](../../specs/003-agentcore-substrate/plan.md).
- **CI/CD:** CodeBuild webhook on `main` → build 4 images (web/migrator/worker/memory-worker) from
  [apps/web/Dockerfile](../../apps/web/Dockerfile) → push to ECR → migrator dry-run → **forced**
  `ecs update-service --force-new-deployment` on all 3 services → `wait services-stable` →
  authenticated prod smoke ([buildspec.yml](../../buildspec.yml)). GitHub Actions runs CI
  (lint/typecheck/test/build) and Playwright product smoke; merge ⇒ live. No blue/green.

## 11. Cost model today (inputs only — see [specs/cost-model.md](specs/cost-model.md) for the model)

Spend concentrates in three places; the repo gives us the inputs but not the bills:

1. **Fargate compute (always-on):** prod = 1 vCPU + 2 GiB across 3 tasks, 24×7; the runtime-v2
   preview cluster doubles that if left running. Order-of-magnitude ~$1.6–1.7k/yr per cluster at
   on-demand Fargate rates (compute only). *Needs: actual desired-counts in prod, whether preview is on.*
2. **Bedrock model inference (variable, the likely #1 sink at scale):** Converse calls per turn ×
   (input ctx + output) × per-model rate (Haiku ≈ $0.80/$4, Sonnet ≈ $3/$15, Opus ≈ $15/$75 per 1M).
   Tool turns multiply model calls (one per loop iteration). **No token/cost metric is emitted today**
   ([run-reporting.ts](../../apps/web/lib/admin/run-reporting.ts)) → current spend visibility is
   Cost Explorer / Bedrock console only. *Needs: per-day token volumes by model.*
3. **RDS Postgres:** instance class not in CDK (imported); likely the third sink. *Needs: instance class, Multi-AZ y/n, storage.*
4. Minor: public-subnet egress to GitHub/Notion/Bedrock ($0.045/GB), ECR storage, CloudWatch ingest.

What we **cannot** estimate without you: real DAU, turns/user/day, avg context size, RDS class,
whether the preview cluster runs continuously. These are listed in [04-open-questions.md](04-open-questions.md).

---

## What this means for the migration (carried into [02-target-architecture.md](02-target-architecture.md))

- The **`AgentRuntime` seam is the migration's best friend**: a Harness adapter is a third
  implementation alongside `BedrockRuntime`/`AgentCoreRuntime`, swappable per-lane by config.
- **Replaceable by Harness config:** the loop itself, the tool registry, MCP wiring, context-window
  truncation, model selection, streaming, session memory, versioning/endpoints.
- **Stays in Comparative (the "enterprise shell"):** PingOne auth, the `runs`/`chat_messages` ledger,
  the Skills catalog & SKILL.md format ([adr/0002](../adr/0002-skill-format.md)), routing policy,
  context-pack assembly, the attestation/redaction/honesty governance, and the Notion same-origin relay.
- **Open seam risks:** per-user MCP bearer-token injection vs. Harness/Gateway's own outbound-auth
  model; whether the honesty/attestation layer maps onto Harness's tool model; the Notion relay's
  same-origin assumption if the loop moves into AWS-managed compute.
