# ADR 002 — Model channel: Bedrock-native vs Claude Platform on AWS

- **Status:** Proposed — **needs Rob's decision (B2)**
- **Date:** 2026-06-19
- **Deciders:** Rob
- **Context docs:** [02 §8](../02-target-architecture.md), [cost-model](../specs/cost-model.md), [security](../specs/security-and-compliance.md)
- **Relates to:** [docs/adr/0003-aws-only-runtime-substrate.md](../../adr/0003-aws-only-runtime-substrate.md)

## Context

Harness supports multiple model channels (Bedrock / OpenAI / Gemini / LiteLLM). For Claude
specifically there are two ways to consume it on AWS: **Bedrock-native** (inference profiles like
`us.anthropic.claude-sonnet-4-6`, already wired — [models.ts](../../../packages/agent/src/models.ts))
vs **Claude Platform on AWS** (Anthropic's first-party channel, which historically lands new Claude
features same-day). The choice affects billing alignment, IAM scoping, residency, and how quickly we
get new model capabilities. ADR 0003 committed us to an AWS-only substrate; both options satisfy that.

## Decision (proposed)

**Default to Bedrock-native** for production harnesses; **evaluate Claude Platform on AWS for a
specific high-value harness** where day-0 features or higher rate limits matter. Revisit once real
usage and any feature gaps are known (B2/S6).

## Options

| | Bedrock-native (proposed default) | Claude Platform on AWS |
|---|---|---|
| Billing | unified AWS bill / EDP alignment (GP-friendly) | separate channel; reconcile |
| IAM | model ARNs scoped in exec role ([iam](../specs/iam-and-execution-roles.md)) | channel-specific auth |
| Features | Bedrock cadence | day-0 Anthropic features |
| Residency | cross-region `us.` profiles (confirm B6) or single-region | confirm channel residency |
| Migration | **zero change** — already on Bedrock | new channel config |

## Consequences

- **Bedrock-native:** simplest enterprise/billing story, zero migration from today; may trail on the
  newest model features.
- **Claude Platform:** fastest access to new capabilities and possibly better limits; adds a billing/
  residency surface to clear with InfoSec and procurement.
- **Reversible:** Harness makes the channel a config field, so a per-harness choice (and later switch)
  is low-cost — this decision is not a one-way door.
