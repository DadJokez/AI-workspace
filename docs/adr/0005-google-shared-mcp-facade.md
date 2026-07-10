# ADR 0005 - Google alpha uses one shared governed MCP facade

- **Status:** Accepted
- **Date:** 2026-07-09
- **Deciders:** Rob, Comparative engineering
- **Related:** [ADR 0003](./0003-aws-only-runtime-substrate.md), [ADR 0004](./0004-agentcore-gateway-integration-pattern.md), [GitHub issue #297](https://github.com/DadJokez/AI-workspace/issues/297)

## Context

Comparative has two tool-capable execution lanes: ordinary interactive tool
turns stream through the Bedrock runtime in ECS, while durable work runs in
AgentCore Runtime. Gmail and Calendar must be fast enough for normal chat and
must behave identically when a task escalates to AgentCore.

ADR 0004 proposes AgentCore Gateway as the default for new business-system
integrations. A Gateway-only Google target would currently make the fast ECS
lane depend on a second workload identity/token path or force all Google turns
onto the slower durable worker. Shipping separate ECS and Gateway tools would
also duplicate schemas, write rules, tests, and audit behavior.

## Decision

For the Google alpha, use one first-party HTTP MCP facade hosted by the
Comparative web service and mount it into both the Bedrock and AgentCore lanes.
The model-visible provider remains `google` in either lane.

The facade has these non-negotiable controls:

- Per-user OAuth tokens are AES-256-GCM encrypted in `oauth_tokens`; expired
  access tokens are refreshed server-side and missing or insufficient grants
  produce an explicit reconnect state.
- The OAuth grant requests Gmail read, Gmail compose, Calendar read, and owned
  event scopes. The facade exposes Gmail draft creation but no send operation.
- `tools_catalog` and `user_tool_attestations` gate every model-visible tool.
- Each interactive turn carries a server-signed user/thread/run context. Draft
  creation is mounted only for an explicit draft request.
- Calendar creation is two-turn: `prepare_event` persists a bounded proposal;
  `create_event` is mounted only after a later strict user confirmation and
  uses a deterministic Google event id for retry safety.
- Scheduled and background runs receive read-only turn context.
- Email and calendar content is nonce-framed as untrusted data. Audit and run
  events retain provider, tool, actor, status, timing, and safe counts without
  copying mail bodies, search text, attendees, or event descriptions.

This is a transport decision, not a permanent credential-vault decision. The
MCP tool names and schemas are the stable contract.

## Consequences

**Positive**

- Gmail and Calendar stay on the fast streaming path for normal chat.
- Fast and durable work share one implementation, allowlist, confirmation
  policy, audit vocabulary, and test suite.
- The alpha does not need a second Google consent flow or force users to choose
  a runtime.
- AgentCore Identity/Gateway can replace credential retrieval or transport
  later without changing the model-visible tools.

**Negative / risks**

- Comparative owns Google token refresh and API adaptation during the alpha.
- The web service is an additional hop for Google calls from AgentCore.
- Restricted Gmail scopes still require Google's production verification and
  security review before broad distribution.
- This is a documented exception to ADR 0004's proposed default, not a reason
  to abandon the Gateway spike for Salesforce and other systems.

## Alternatives considered

- **Gateway-only Google tools.** Deferred because it would either slow every
  Google turn or require a separate fast-lane workload identity before the
  product value is validated.
- **Two Google tool implementations.** Rejected because write authorization
  and prompt-injection controls must not diverge by runtime.
- **Expose Google REST operations directly to the model.** Rejected because
  Google's OAuth scopes are broader than Comparative's approved product
  actions, especially Gmail compose and Calendar event mutation.

## Revisit when

- The fast ECS lane has a production workload identity that can use AgentCore
  Identity without adding noticeable first-token latency.
- The AgentCore Gateway spike proves equivalent per-user OAuth, signed
  confirmation, nonce framing, and redacted audit behavior.
- Google production verification requires a different credential boundary.
- The MCP facade becomes an operational bottleneck or duplicates another
  provider implementation enough to justify a shared connector service.
