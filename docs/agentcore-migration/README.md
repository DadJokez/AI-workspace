# Comparative → AgentCore Harness migration

Discovery, target architecture, specs, and a phased roadmap for moving Comparative's agent loop onto
AWS Bedrock **AgentCore Harness** (GA 2026-06-17). Planning only — no application/infra code in this set.

## The one-line thesis

Comparative already runs **two** agent loops we maintain (in-process Bedrock for chat; a custom-code
AgentCore *Runtime* container for durable lanes). The managed Harness lets both collapse into
**configuration**, reached through the existing `AgentRuntime` seam. Justification is **operability +
capability** (managed memory, tracing, per-model cost visibility, instant rollback), **not** infra
cost — model inference dominates spend and doesn't move.

## Read in this order

1. [01-current-state.md](01-current-state.md) — what exists today, file-cited (start here).
2. [02-target-architecture.md](02-target-architecture.md) — service boundary, data-flow + identity diagrams.
3. [03-roadmap.md](03-roadmap.md) — phases A–F, gates, stop conditions, ~18 dev-weeks.
4. [04-open-questions.md](04-open-questions.md) — what Rob/InfoSec must decide (blocking first).
5. [05-adr/](05-adr/) — ADRs 001–005 (all Proposed).
6. [specs/](specs/) — gateway targets, skills, IAM, observability, eval, **cost model**, security, and
   3 `CreateHarness` example JSONs.

## Confirmed framing (2026-06-19)

- **Three-way convergence** onto managed Harness (chat loop + Runtime workers).
- Integration set = **shipped connectors + roadmap wedges** (SAP/M365/Salesforce/ServiceNow).
- Enterprise IdP = **PingOne / PingFederate OIDC** (`users.ping_subject` already wired).

## Top blocking questions (see [04](04-open-questions.md))

AgentCore region availability (B1) · Bedrock-native vs Claude-Platform (B2/ADR-002) · InfoSec microVM
review (B3) · dedicated AWS account (B4) · move off public subnets (B5) · inference-profile residency (B6).
