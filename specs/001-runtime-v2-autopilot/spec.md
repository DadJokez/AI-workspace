# Feature Specification: Runtime V2 Autopilot

**Feature Branch**: `001-runtime-v2-autopilot`
**Working Branch**: `codex/spec-kit-runtime-v2`
**Created**: 2026-05-29
**Status**: Ready for issue tracking
**Input**: User description: "Default to the simplest fast local chat path, automatically use tools or durable execution only when the ask requires it, and measure first-token latency."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Fast Ordinary Chat (Priority: P1)

A user sends a normal conversational prompt and sees text start streaming quickly without waiting for a queued worker or a fresh tool agent.

**Why this priority**: This is the daily feel of the product. If simple chat feels slow, the rest of the agent platform feels broken even when it is technically capable.

**Independent Test**: Send `say pong and nothing else` through the Runtime V2 preview or production environment with Runtime V2 enabled. The response should stream inline and store a `fast-local` runtime route.

**Acceptance Scenarios**:

1. **Given** Runtime V2 is enabled, **When** a user sends a simple prompt, **Then** `/api/chat` chooses `lane = "fast-local"` and `runtimeTarget = "direct-chat"`.
2. **Given** a fast-local turn is running, **When** the first non-empty text delta arrives, **Then** the run records `firstTokenAt` and `requestToFirstTokenMs`.
3. **Given** a fast-local turn completes, **When** an admin opens run detail, **Then** route, target, model, and first-token latency are visible.

---

### User Story 2 - Automatic Tool Escalation (Priority: P2)

A user asks the assistant to inspect GitHub, pull requests, issues, CI, branches, workflows, or repository state, and the assistant automatically routes to the local Bedrock agent path with the needed MCP provider mounted.

**Why this priority**: The user should not choose a tool or agent mode. "Take a peek in my GitHub" should just work while ordinary chat stays fast.

**Independent Test**: Ask for the last three PRs from GitHub with a connected and attested GitHub provider. The turn should use `tool-local`, mount GitHub, stream activity, and persist redacted tool calls/results.

**Acceptance Scenarios**:

1. **Given** the user has GitHub connected and approved, **When** the prompt clearly asks for GitHub/PR/CI inspection, **Then** the route chooses `lane = "tool-local"` and `runtimeTarget = "bedrock-agent"`.
2. **Given** a tool-local turn calls GitHub MCP, **When** the turn completes, **Then** tool calls/results are stored on `chat_messages`, replayable through `run_events`, and audit rows are written.
3. **Given** the user does not have required provider approval, **When** the prompt needs that provider, **Then** the assistant gives a clear approval/access message instead of silently falling back to hallucinated content.

---

### User Story 3 - Durable Work Escalation (Priority: P3)

A user asks the assistant to implement, test, deploy, refactor, migrate, or perform other work that may outlive the browser request, and the system routes the turn to the durable worker path.

**Why this priority**: Long-running code or infrastructure work must survive refreshes and disconnects without making every simple chat pay for durable orchestration.

**Independent Test**: Send a prompt such as `implement a small fix and run tests`. The turn should create a queued durable run that the chat worker claims, while retry/resume/cancel continue to work.

**Acceptance Scenarios**:

1. **Given** a prompt contains durable-work intent, **When** `/api/chat` receives it, **Then** the route chooses `lane = "durable-local"` and returns a pending run id.
2. **Given** the browser refreshes during durable work, **When** the user reopens the thread, **Then** the pending run and activity timeline reload from persisted run state.
3. **Given** a durable run fails or is canceled, **When** the user retries or resumes, **Then** the original execution mode and route intent are preserved.

---

### User Story 4 - Legacy Cloud Mode Remains Disabled (Priority: P4)

A legacy client or stored request may still send `executionMode = "cloud"`, but current Runtime V2 should normalize it to local execution until a new approved cloud escape hatch is introduced.

**Why this priority**: Accidental cloud-by-default was a root cause of slow simple chats. The product should keep local execution as the only current chat path unless a future cloud design is explicitly reintroduced.

**Independent Test**: Send a request with legacy `executionMode = "cloud"`. The server should store and run the turn as `executionMode = "local"`.

**Acceptance Scenarios**:

1. **Given** no execution mode is supplied, **When** a user sends ordinary chat, **Then** the run uses local execution.
2. **Given** a legacy client sends `executionMode = "cloud"`, **When** `/api/chat` routes the turn, **Then** the run stores `executionMode = "local"`.
3. **Given** an older historical run reports `cursor-cloud`, **When** admin views render it, **Then** reporting can still display the historical lane without making it a current router option.

---

### User Story 5 - Safe Model Fallback (Priority: P5)

A user should not hit an opaque model-access error when the selected/default model is denied by the active provider. The app should prefer the configured fast allowed model or show a clear recoverable message.

**Why this priority**: The Runtime V2 speed win is undermined if normal asks fail because the direct runtime chooses a model the AWS account cannot access.

**Independent Test**: Configure direct chat with a denied direct model and send a fast-local prompt. The app should use the configured fallback model or return a clear actionable error that identifies the access problem.

**Acceptance Scenarios**:

1. **Given** direct chat uses Bedrock, **When** the user-selected product model is not available in Bedrock, **Then** the direct runtime maps to an allowed direct model by policy.
2. **Given** Bedrock returns a model access denial, **When** the turn fails, **Then** the user sees a clear message and the run records provider/model/error metadata for admin diagnosis.

### Edge Cases

- Runtime V2 disabled: simple chat should fall back to the current configured runtime path without changing user-visible API shape.
- GitHub-looking prompt from a user without GitHub OAuth tokens: route may classify as tool-local, but provider mount must remain gated by connection and attestation state.
- Ambiguous prompt such as "review this": conservative routing should prefer fast local unless code/repo/tool signals are present.
- The direct runtime returns text but final persistence fails: the run must record enough failure state for admin diagnosis without duplicating assistant messages on retry.
- A prompt asks for personal context or Vault memory: route remains fast-local, but approved memory can be injected without mounting external MCP tools.
- A provider access error occurs mid-stream: the response and run events should distinguish model/provider denial from generic infrastructure failure.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST default ordinary chat requests to local execution.
- **FR-002**: System MUST choose `fast-local`, `tool-local`, or `durable-local` per turn without requiring the user to pick a product mode.
- **FR-003**: System MUST route simple Runtime V2 chat through `direct-chat` when `RUNTIME_V2_ENABLED=1`.
- **FR-004**: System MUST keep tool turns on the local Bedrock agent path and durable turns on the AgentCore worker path.
- **FR-005**: System MUST mount MCP providers only when the selected route and provider gates require them.
- **FR-006**: System MUST persist route, target, execution mode, and model choices in `recipe_runs.inputs` and/or `recipe_runs.outputs`.
- **FR-007**: System MUST record timing marks for request accepted, runner/provider start, first token, and completion.
- **FR-008**: System MUST expose first-token and total-duration metrics in admin run views.
- **FR-009**: System MUST preserve retry/resume/cancel behavior for durable runs.
- **FR-010**: System MUST normalize legacy cloud execution requests to local unless a future approved cloud design is reintroduced.
- **FR-011**: System MUST provide a deterministic initial router before adding a model-based classifier.
- **FR-012**: System MUST avoid selecting denied direct-runtime models when an allowed configured fallback exists.
- **FR-013**: System MUST create focused GitHub issues for remaining rollout and hardening work, linked back to this Spec Kit packet.

### Key Entities *(include if feature involves data)*

- **Runtime Route**: Per-turn decision containing lane, runtime target, execution mode, worker usage, and reason.
- **Recipe Run**: Existing durable ledger row for chat, workflow, scheduled, and future recipe execution.
- **Run Metrics**: Timing object persisted in run outputs for accepted/start/first-token/completed timestamps and elapsed milliseconds.
- **Provider Run Metadata**: Provider identifiers and execution mode stored for recovery and diagnostics.
- **Model Mapping Policy**: Runtime-specific mapping from product model ids to provider model ids, including direct-runtime fallback behavior.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A simple chat request with Runtime V2 enabled stores `lane = "fast-local"` and `runtimeTarget = "direct-chat"`.
- **SC-002**: At least 95 percent of fast-local successful runs have `requestToFirstTokenMs` populated.
- **SC-003**: GitHub-looking prompts route to `tool-local` and do not use durable work unless the request requires it.
- **SC-004**: Durable-looking prompts create queued worker runs while simple prompts do not.
- **SC-005**: The admin run list/detail pages show enough timing data to compare Runtime V1 queued-agent fast chat, Runtime V2 direct chat, and Runtime V2 tool-local chat.
- **SC-006**: Production rollout has a documented smoke result for simple chat, GitHub/tool chat, durable worker chat, legacy cloud-normalization, and model-access fallback.

## Assumptions

- The direct fast-local runtime starts with Bedrock because that path already exists behind the `AgentRuntime` seam.
- Runtime V2 currently uses Bedrock for direct/tool-local work and AgentCore for durable worker execution.
- The preview stack at `https://runtime-v2.ai-workspace.builtwithrobot.link` remains available until production rollout is validated.
- Production can scale web tasks after the `rate_limit_buckets` shared limiter
  migration is deployed and the 429 smoke passes across at least two web tasks.
- The current DB-backed run ledger remains the source of truth; no new run table is required for this feature.
- This packet documents/adopts a Spec Kit-style workflow without merging the full exploratory `spec-kit/` vendor PR.
