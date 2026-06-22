# ADR 004 — Identity & on-behalf-of model (PingOne → AgentCore actor)

- **Status:** Proposed
- **Date:** 2026-06-19
- **Deciders:** Rob, GP IT (PingOne), InfoSec
- **Context docs:** [02 §3](../02-target-architecture.md), [iam](../specs/iam-and-execution-roles.md), [security](../specs/security-and-compliance.md)

## Context

Human sign-in today is **GitHub OAuth via NextAuth (POC)**; the enterprise requirement is **PingOne /
PingFederate OIDC**, and the schema is already shaped for it — the external subject lives in
`users.ping_subject` ([packages/db/src/schema.ts:111](../../../packages/db/src/schema.ts),
[docs/ARCHITECTURE.md:124](../../ARCHITECTURE.md), [PLAN.md:81](../../../PLAN.md)). Per-user connector
creds are separate, in encrypted `oauth_tokens`. With the loop moving to managed Harness, we must
decide how an authenticated human becomes the agent's identity and how the agent acts on systems
on-behalf-of the user **without seeing raw credentials**.

## Decision

1. **Human → shell:** PingOne/PingFederate OIDC via a NextAuth provider swap (no DB migration; `sub` →
   `users.ping_subject`). `users.id` (UUID) remains the canonical principal.
2. **Shell → Harness (inbound):** the shell calls `InvokeHarness` with **SigV4** from a per-harness
   task role (the shell is the trusted, already-authenticated caller) and passes **`actorId =
   users.id`** + `X-Amzn-…-Runtime-User-Id`.
3. **Tenancy:** isolation is **per-`actorId`**, not per-harness — same UUID `userScope()` uses for RDS
   ([scope.ts](../../../apps/web/lib/auth/scope.ts)).
4. **On-behalf-of tools:** **AgentCore Identity token vault via Gateway outbound auth** mints per-user,
   per-call tokens; the model never sees a credential. Replaces in-process decrypt-and-bearer.
5. **Scoping:** `allowedTools` glob per invocation + Gateway target scopes tied to the actor.

## Options for inbound auth

| | SigV4 from shell (chosen) | Harness inbound OAuth with PingOne authorizer (`authorizerConfiguration`) |
|---|---|---|
| Trust | shell already authenticated the human; owns audit | Harness validates the user token directly |
| Simplicity | reuses existing task-role auth | another OIDC integration point |
| Audit | shell ledger is the SoR | split between Harness + shell |

Chosen SigV4-from-shell because the shell is the enterprise boundary that already does auth, context,
and audit; revisit if we ever want direct user→Harness calls (e.g. Step Functions).

## Consequences

**Positive:** PingOne swap is a one-config change (already designed for); raw creds leave the model
path entirely (security upgrade); per-user isolation invariant unchanged; one exec role per harness
keeps IAM simple.

**Negative / risks:** Identity-vault connector onboarding per system; dual-run of `oauth_tokens` +
vault during migration; must confirm PingOne vs PingFederate specifics + claim mapping
([04 S1](../04-open-questions.md)); InfoSec review of the vault.
