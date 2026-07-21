# Spec — Security & Compliance (enterprise)

> What changes for trust, data-scoping, residency, audit, and shared-responsibility when the loop moves
> to managed AgentCore. Anchored to Comparative's existing posture
> ([docs/ENTERPRISE_READINESS.md](../../ENTERPRISE_READINESS.md), [CLAUDE.md] review rubric).

## Assumptions

- Enterprise IdP = **PingOne / PingFederate OIDC**; data must stay in approved AWS region(s); the org's
  InfoSec team will review the runtime isolation model.
- AgentCore runs in **the org's own AWS account** (extends [adr/0003-aws-only-runtime-substrate.md](../../adr/0003-aws-only-runtime-substrate.md):
  "all runtime in AWS, no transcripts to third parties").

## Data residency

- Pin every harness, Gateway, Memory, and skills bucket to the **approved region** (`us-east-1` today).
  **Blocking question:** confirm AgentCore GA includes that region ("all regions where AgentCore is GA"
  — not enumerated in docs; [04-open-questions.md](../04-open-questions.md)).
- Model inference via **Bedrock cross-region inference profiles** (`us.` prefix,
  [models.ts](../../../packages/agent/src/models.ts)) can route across US regions — confirm this is
  within the org's residency boundary, or switch to single-region profiles ([models.ts:6](../../../packages/agent/src/models.ts)
  notes the swap). This is a residency landmine analogous to the "Cursor residency" issue already on record.
- Managed Memory and skills S3 are new at-rest data stores — encrypt with the org CMK, keep in-region.

## Audit trail

- **Two layers, both retained:** (1) our redacted `auditLog`/`run_events` in RDS — the
  honesty/attestation system-of-record ([apps/web/lib/audit-tool-events.ts](../../../apps/web/lib/audit-tool-events.ts));
  (2) AgentCore GenAI Observability traces + **CloudTrail** (harness ops logged under
  `AWS::BedrockAgentCore::Runtime`). Correlated by `runs.id`.
- This is *more* auditable than today (we gain per-step traces + CloudTrail control-plane events).

## Data scoping (no cross-user leakage)

- Per-user isolation rides on **`actorId = users.id`** for memory and `userScope()` for RDS
  ([apps/web/lib/auth/scope.ts](../../../apps/web/lib/auth/scope.ts)) — unchanged invariant.
- **On-behalf-of without raw creds:** Identity token vault mints per-user, per-call tokens for Gateway
  targets; the model never sees a credential ([02 §3](../02-target-architecture.md)). This is a
  **security upgrade** over decrypting `oauth_tokens` in-process ([oauth/crypto.ts](../../../apps/web/lib/oauth/crypto.ts)).
- `allowedTools` glob per invocation enforces that a given skill/agent can only reach the targets it
  needs (e.g. budget agent ⇒ `@sap-erp-fi/*` only).

## Secrets handling

- Migrate connector secrets from `oauth_tokens` (AES-256-GCM via `OAUTH_ENCRYPTION_KEY`) to the
  **Identity token vault** per connector as it moves to Gateway. Keep the existing path for connectors
  not yet migrated (dual-run during migration).
- App secrets (`DATABASE_URL`, `NEXTAUTH_SECRET`, PingOne client config) stay in Secrets Manager
  ([ai-workspace-ecs-stack.ts:83](../../../infra/cdk/lib/ai-workspace-ecs-stack.ts)). **No secrets in
  skills bundles** — enforced by the no-secrets scan at publish ([skills-bundle-structure.md](skills-bundle-structure.md)).

## Content guardrails & prompt-injection

- **Keep our nonce-delimited untrusted-content framing** ([apps/web/lib/artifact-context.ts:157](../../../apps/web/lib/artifact-context.ts))
  — apply it in the shell *before* building the `systemPrompt[]`/messages we pass to `InvokeHarness`.
  This is the [CLAUDE.md] priority-2 pattern; do not drop it just because the loop moved.
- **Add Bedrock Guardrails** (today ❌, [01 §9](../01-current-state.md)) at the model layer for denied
  topics + PII — now worth doing since model invocation is centralized in the harness config.
- Redaction ([tool-redaction.ts](../../../apps/web/lib/tool-redaction.ts)) stays in the shell on the
  persistence path so the audit ledger remains scrubbed.

## Isolation model (for InfoSec review)

- Each harness **session runs in its own microVM** with its own filesystem/shell (doc-sourced) —
  stronger isolation than our shared-process in-Fargate loop today. Prepare an InfoSec brief on the
  microVM model (this is an explicit open question — [04-open-questions.md](../04-open-questions.md)).
- Network: **move off PUBLIC subnets to private + PrivateLink before any real enterprise data**
  ([01 §10](../01-current-state.md) landmine). Hard gate.

## AWS shared-responsibility split

| Layer | Owner |
|---|---|
| MicroVM isolation, runtime patching, loop infra, scaling, Gateway/Memory service security | **AWS** |
| IAM least-privilege, KMS keys, region pinning, network (private subnets), Guardrails config | **The org (us)** |
| PingOne identity, `actorId` scoping, attestation, redaction, honesty preamble, audit ledger | **The org (us — the enterprise shell)** |
| Skill content, prompts, tool scopes, eval gates | **The org (us)** |

## Human-owned changes (per [CLAUDE.md] — Rob + InfoSec, not Claude/Codex)
- New IAM/KMS, Identity vault connector registrations, PingOne provider swap, private-subnet network
  change, region/account decisions, Bedrock Guardrails policy, any new production dependency.
