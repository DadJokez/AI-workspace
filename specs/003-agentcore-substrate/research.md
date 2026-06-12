# Research: AgentCore Substrate Spike

**Date**: 2026-06-12 · **Status**: verified against live AWS docs during the spike

## What Amazon Bedrock AgentCore is (the parts that matter to AI Hub)

| Service | What it does | What it overlaps in AI Hub |
|---|---|---|
| **Runtime** | Serverless, session-isolated hosting for *your* agent container (any framework/language). You bring the loop; AWS brings isolation, scaling, and the invoke API. | The chat-worker's runtime execution; the Cursor Cloud "durable" lane |
| **Gateway** | Turns APIs/Lambdas/OpenAPI specs into managed MCP servers with credential injection | `apps/web/lib/oauth/mcp-servers.ts` + per-integration MCP plumbing |
| **Identity** | Managed OAuth token vault (2LO/3LO) for agents acting on users' behalf | `oauth_tokens` + AES-256-GCM crypto + refresh logic |
| **Memory / Observability** | Managed agent memory; OTel-based tracing | Vault memory; run_events/metrics |

The strategic read from the June strategy session stands: **for an IT reviewer, "AWS-managed" beats hand-rolled for every row of that table** — and Bedrock is already an approved pattern at Koch. Runtime is adoptable today behind the seam; Identity and Gateway are incremental follow-ups that *shrink* AI Hub's custom governance code.

## Verified technical facts

**Container contract** (Runtime hosts any container that speaks it):
- `POST /invocations` — JSON in, response out (we use `text/event-stream`)
- `GET /ping` — `{"status": "Healthy" | "HealthyBusy", "time_of_last_update": <unix-seconds>}`
- Port **8080**, image must be **linux/arm64**, pulled from **ECR**

**InvokeAgentRuntime** (data plane, `@aws-sdk/client-bedrock-agentcore`, verified at v3.1067.0):
- Params: `agentRuntimeArn` (req), `runtimeSessionId` (**33–256 chars** — thread UUIDs at 36 pass through), `payload` (binary, ≤100 MB), `contentType`, `accept`, optional `qualifier`
- Response: `contentType` + `response` byte stream; SSE when the container answers `text/event-stream`
- IAM: `bedrock-agentcore:InvokeAgentRuntime` (+ `...ForUser` if the user-id header is used)
- Same `runtimeSessionId` ⇒ same isolated session/microVM — maps 1:1 onto AI Hub thread ids

**CloudFormation** (`AWS::BedrockAgentCore::Runtime`):
- Required: `AgentRuntimeName` (pattern `[a-zA-Z][a-zA-Z0-9_]{0,47}` — **no dashes**), `AgentRuntimeArtifact.ContainerConfiguration.ContainerUri` (ECR), `NetworkConfiguration` (`{NetworkMode: "PUBLIC"}` or VPC), `RoleArn`
- Optional: `ProtocolConfiguration` (`HTTP` | `MCP` | `A2A` | `AGUI`), `EnvironmentVariables`, lifecycle/headers
- `Fn::GetAtt`: `AgentRuntimeArn`, `AgentRuntimeId`, `Status`
- Repo's aws-cdk-lib (2.195) predates the L1 module → declared as raw `CfnResource` (version-proof)

**MCP TypeScript SDK** (`@modelcontextprotocol/sdk` 1.29.0, verified from installed types):
- `Client` + `StreamableHTTPClientTransport(url, { requestInit: { headers } })` — per-user bearer rides the headers exactly like the Cursor mount
- `listTools()` / `callTool({name, arguments})` → `{content[], isError?, structuredContent?}`

**Constraint found**: SDK-based `InvokeAgentRuntime` is SigV4-only; inbound *OAuth* to a runtime requires raw HTTPS instead. Irrelevant for AI Hub (service-to-service SigV4 is the right model), noted for completeness.

## Sources

- [Invoke an AgentCore Runtime agent](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-invoke-agent.html)
- [InvokeAgentRuntime API reference](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_InvokeAgentRuntime.html)
- [Host agents/tools with AgentCore Runtime](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agents-tools-runtime.html) · [Get started without the CLI](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/getting-started-custom.html)
- [AWS::BedrockAgentCore::Runtime CFN reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-bedrockagentcore-runtime.html)
- [How AgentCore Runtime works](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-how-it-works.html)
