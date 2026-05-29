# Research: Runtime V2 Autopilot

## Decision 1: Use Spec Kit-style feature packet without vendoring Spec Kit

**Decision**: Create `/specs/001-runtime-v2-autopilot/` with `spec.md`, `plan.md`, `tasks.md`, research, data model, contracts, and rollout checklist. Do not merge the exploratory full `spec-kit/` copy.

**Rationale**: The repo needs the workflow discipline and traceability, not a large vendored reference tree. The full Spec Kit PR remains useful as a reference but is not required for Runtime V2 tracking.

**Alternatives considered**:

- Merge the full `spec-kit/` PR. Rejected because it adds a large unrelated reference tree and does not itself create project-specific tasks.
- Keep only freeform docs. Rejected because the missing piece is issue/task traceability.

## Decision 2: Keep direct chat behind Runtime V2 flag

**Decision**: Direct chat remains gated by `RUNTIME_V2_ENABLED=1`.

**Rationale**: Production can roll back to Cursor-agent behavior by config while preview/prod timing data is gathered.

**Alternatives considered**:

- Make direct chat unconditional. Rejected because the rollout still needs model-access fallback and smoke verification.

## Decision 3: Use deterministic router first

**Decision**: Keep the first router rule-based: cloud request, durable keywords, GitHub/tool keywords, personal-context keywords, otherwise fast-local.

**Rationale**: It is explainable, testable, cheap, and enough to validate the user experience. It also avoids adding another model call before first token.

**Alternatives considered**:

- LLM classifier before each turn. Deferred until production route data shows heuristic routing is too brittle.
- User-facing tool/mode selector. Rejected because the desired experience is autopilot.

## Decision 4: Direct fast-local runtime starts with Bedrock

**Decision**: Fast-local direct chat uses the existing Bedrock-backed runtime path when Runtime V2 is enabled.

**Rationale**: It avoids creating a fresh Cursor agent for simple chat and reuses the existing `AgentRuntime` fallback contract.

**Alternatives considered**:

- Use Cursor SDK direct/no-tool agent for fast-local. Worth revisiting if Cursor exposes a truly minimal direct chat path with comparable latency.
- Use Cursor Cloud for fast-local. Rejected because it caused the original slowdown.

## Decision 5: Existing run ledger remains canonical

**Decision**: Continue storing Runtime V2 decisions and metrics in `recipe_runs` and `run_events`.

**Rationale**: The app already uses `recipe_runs` for chat-originated, workflow, scheduled, and future recipe execution. A second run table would add migration and UI complexity without solving a current problem.

**Alternatives considered**:

- Create `agent_runs`. Rejected earlier in favor of the generalized run ledger documented in `docs/RUNS_DECISION.md`.

## Decision 6: Production rollout waits for smoke and timing comparison

**Decision**: Keep the preview stack as the validation target, then enable Runtime V2 on production only after smoke tests and timing comparisons are recorded.

**Rationale**: Runtime speed is experiential. Admin first-token metrics let us verify the improvement with real runs before flipping production.

**Alternatives considered**:

- Flip production immediately after merge. Rejected because the model-access issue already showed one provider-specific failure mode.
