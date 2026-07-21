# Comparative — Architecture Overview & Design Decisions

**Audience:** Enterprise IT, Enterprise Architecture, Security, Infrastructure, Platform Engineering  
**Purpose:** Informational architecture overview for early partner review  
**Status:** Draft for discussion  

> This is not the full security review, threat model, or production readiness package. It is a plain-language architecture and decision summary intended to help enterprise IT partners understand what Comparative is, what it owns, what it deliberately does not own, and where the design still needs enterprise hardening.

---

## 1. Executive Summary

Comparative is an internal enterprise AI workspace: one governed front door where employees can chat with AI, use AI against approved work systems, save reusable agents as **Skills**, run those Skills on schedules or governed events, share Skills and lightweight Apps with teammates, and receive proactive work through a notification center.

The architectural thesis is intentionally narrow:

> Comparative should be the enterprise control plane and user experience layer around existing AI and work platforms. It should not rebuild AWS Bedrock, Microsoft 365, Salesforce, Workfront, Databricks, GitHub, SAP, or app hosting platforms unless that layer is needed for governance, audit, control, portability, or user experience.

The current system is built as a TypeScript / Next.js monorepo with Postgres persistence, AWS Bedrock for fast interactive AI turns, Amazon Bedrock AgentCore for durable worker execution, and MCP servers as the integration boundary for enterprise systems.

---

## 2. Product Scope

Comparative currently supports or is designed around five core journeys.

| Journey | Description | Current posture |
|---|---|---|
| J1 — Chat | Multi-turn AI chat with persisted user history, file/image support, model selection, and user memory controls | Shipped |
| J2 — Chat with Tools | Chat that can read from or act against connected work systems through MCP tools | In progress; GitHub live |
| J3 — Proactive Agents | Skills that run on a schedule or signed GitHub event and deliver results into a designated thread and notification center | Shipped for schedules, PR reviews, and failed CI |
| J4 — Apps | Lightweight internal apps generated from chat artifacts and served behind workspace auth | Thin slice shipped |
| J5 — Share | Skills and Apps shared to named teammates using recipient credentials | Seed shipped |

This product framing matters for IT review because Comparative is not only a chatbot. It is a governed workspace for AI-assisted work, reusable automation, scheduled execution, lightweight app delivery, and organizational reuse.

---

## 3. High-Level Architecture

```text
User / Browser / Scheduled Job / Signed GitHub Event
        |
        v
Comparative Web Shell
Next.js App Router, TypeScript, Tailwind
        |
        | owns identity, UI, policy, persistence, audit, skill/app/share UX
        v
AgentRuntime Seam
single runtime abstraction used by chat, skills, schedules, event triggers, workflows
        |
        +-----------------------------+
        |                             |
        v                             v
AWS Bedrock Runtime              Amazon Bedrock AgentCore Runtime
fast chat + tool turns           durable chat, skills, schedules, event triggers, future app-build jobs
        |                             |
        +-------------+---------------+
                      |
                      v
MCP Integration Layer
GitHub live; M365, Workfront, Salesforce, Databricks, ServiceNow, SAP planned
                      |
                      v
Enterprise Systems of Record
GitHub, Microsoft 365, Salesforce, Workfront, Databricks, Redshift, SAP, etc.
```

---

## 4. Component Ownership

| Layer | Owns | Does not own |
|---|---|---|
| Comparative Web Shell | User experience, auth session, product state, chat threads, Skills, Schedules, Apps, Shares, Recommendations, audit, redaction, provider gates, token storage, admin surfaces | Model protocols, foundation model hosting, raw vendor APIs |
| AgentRuntime | Stable runtime contract between product code and execution substrate | Business-specific workflow logic |
| AWS Bedrock Runtime | Fast interactive model turns, streaming responses, MCP tool turns | Durable product state, scheduling policy, user memory, quota policy |
| Amazon Bedrock AgentCore Runtime | Durable/background execution for worker lanes, session-isolated runtime work | Product ownership of runs, retries, schedules, audit, sharing, UX |
| MCP Servers | Standard tool surface for each connected enterprise system | Cross-system orchestration, model choice, product policy |
| Postgres | Durable product state and ledgers | Long-term data lake analytics; future Agent Wire may use S3/Athena |
| Enterprise Systems | Authoritative business data and side effects | AI orchestration or Comparative governance |

---

## 5. Core Design Decisions

### 5.1 Comparative is a thin enterprise wrapper

Comparative is not trying to replace existing platforms. It adds the missing enterprise layer around AI usage:

- single front door;
- SSO-ready identity boundary;
- reusable Skills;
- scheduling;
- shareability;
- tool connection and attestation UX;
- audit and run history;
- redaction and retention rules;
- model/runtime abstraction;
- integration registry;
- future usage analytics and recommendations.

The guiding rule is: remove enterprise friction, do not rebuild a platform unless Comparative needs that layer for control, audit, governance, user experience, or portability.

### 5.2 Runtime is abstracted behind `AgentRuntime`

The web app does not branch directly on Bedrock versus AgentCore in business logic. Both runtime lanes implement the same `AgentRuntime` interface.

Current runtime split:

| Runtime | Role |
|---|---|
| AWS Bedrock | Low-latency interactive chat and tool turns |
| Amazon Bedrock AgentCore | Durable/background worker execution for chat runs, Skills, Schedules, and future app-build jobs |

This protects the product layer from runtime churn. Model selection, durable execution, reconnect behavior, and future runtime migrations can evolve behind the seam.

### 5.3 MCP is the enterprise integration pattern

Comparative should not add one-off in-process tool wrappers for every enterprise system. New system capability should be exposed as an MCP server.

Current pattern:

- HTTP MCP for delegated per-user OAuth systems;
- stdio/M2M MCP for service-principal systems;
- provider/tool registry in Postgres;
- provider-level attestation before mount;
- future MCP proxy or verified hook path for lower-level category/tool filtering.

This keeps the capability surface inspectable, reusable, and auditable.

### 5.4 Skills are the user-facing automation primitive

The product has moved from the older “recipes” language to **Skills**.

A Skill is a saved, shareable agent definition:

```json
{
  "name": "Developer Briefing",
  "system_prompt": "...",
  "model_id": "sonnet-4-6",
  "mcp_providers": ["github"],
  "params_schema": {}
}
```

Users can create, run, clone, edit, archive, schedule, event-trigger, and share Skills. GitHub triggers install a signed repository webhook through the trigger owner's existing OAuth grant and require repository-admin access. Each delivery is deduplicated, rate-limited, nonce-framed as untrusted data, and executed with the trigger owner's credentials only. Ownership of a Skill does not grant credentials. Every execution re-gates against the executing user’s own provider tokens and attestations.

### 5.5 Runs are the durable execution ledger

The run ledger is now generalized as `runs`, replacing the older `recipe_runs` concept. This is the right name because the ledger tracks chat turns, workflow runs, skill runs, scheduled runs, event-triggered runs, and future app-build jobs.

Associated `run_events` provide a reloadable activity stream so long-running work can be replayed after browser reconnects or worker restarts.

### 5.6 Shares never transfer credentials

The generic `shares` table supports Skill and App sharing. The grant allows a recipient to see, open, run, or clone the shared artifact depending on subject type.

Critical rule:

> Shared execution uses the recipient’s own OAuth tokens and attestations. The owner’s credentials are never delegated through a share.

This is a key enterprise design decision because it preserves least privilege and avoids hidden lateral access.

### 5.7 Apps are currently a thin, governed slice

The current Apps implementation is not yet a full generated-app platform with GitHub repos, pipelines, or per-app AWS services.

Current slice:

- chat-generated artifacts can become Apps;
- Apps are registered in Postgres;
- Apps are served at `/apps/{slug}` behind workspace auth;
- deployed versions point at workspace artifact versions;
- version history and revert exist;
- generated content is subject to no-secrets scanning and restrictive serving policy.

The full J4 vision remains larger: conversational build/iterate/deploy, managed Git substrate, deploy controller, SSO trust, and app-level service provisioning.

---

## 6. Identity and Authorization Model

### 6.1 Shell identity

Current POC identity uses GitHub OAuth through NextAuth.

Enterprise target is PingOne / PingFederate OIDC through the same NextAuth boundary. The schema is already shaped for this: `users.ping_subject` stores the external identity-provider subject. In the current POC that value maps to GitHub identity; in enterprise it should hold the PingOne/PingFederate OIDC subject claim.

### 6.2 Provider authorization

Provider authorization is separate from shell identity.

Example:

- User signs into Comparative through GitHub OAuth today, or PingOne later.
- Separately, the user connects GitHub, M365, Salesforce, or another provider for MCP access.
- Provider OAuth tokens are stored per-user in `oauth_tokens`.
- Tokens are encrypted before persistence.
- At runtime, Comparative mounts only the MCP providers the user has connected and attested.

### 6.3 Attestation model

`user_tool_attestations` records user approval at provider, category, or tool scope.

Current enforcement is provider-level before MCP server mount. Future enforcement should move toward lower-level category/tool filtering through a verified hook path or MCP proxy.

---

## 7. Data Model Summary

Key product tables:

| Table | Purpose |
|---|---|
| `users` | Canonical user record, role, default model, assistant name, onboarding state |
| `chat_threads` | User-owned chat conversations and summary metadata |
| `chat_messages` | Persisted messages, model/runtime metadata, tool calls/results |
| `oauth_tokens` | Encrypted per-user provider tokens |
| `skills` | Saved shareable agent definitions |
| `schedules` | Time-based recurring execution of Skills |
| `event_triggers` | Owner-scoped definitions that map signed external events to Skills and thread behavior |
| `event_trigger_deliveries` | Deduplicated webhook receipt ledger with event summary, status, and resulting run |
| `runs` | Durable ledger for chat, workflows, Skills, schedules, event triggers, and future durable jobs |
| `run_events` | Append-only reloadable activity stream for runs |
| `audit_log` | Compliance/event ledger for tool, workflow, skill, schedule, event-trigger, share, and app actions |
| `mcp_servers` | Admin-curated registry of mountable MCP providers |
| `tools_catalog` | User/admin-visible inventory of MCP tools |
| `user_tool_attestations` | User approval records for provider/category/tool scopes |
| `workspace_artifacts` | Files and app artifacts produced by chat or assistant work |
| `apps` | Thin deployed-app registry |
| `shares` | Generic grants for Skills and Apps |
| `recommendations` | Explicit, dismissible suggestions for tools, Skills, Apps, or schedules |
| `memory_capture_queue` | Queue for reviewing completed chat windows for memory suggestions |
| `user_memory_items` | User-reviewed Vault memory items |
| `rate_limit_buckets` | Shared fixed-window limiter buckets |

---

## 8. Deployment and Infrastructure Posture

### Current / active direction

Comparative is moving to ECS on Fargate as the active enterprise-aligned deployment target.

Current target stack:

| Layer | Current target |
|---|---|
| Web runtime | ECS service on Fargate |
| Worker runtime | Separate ECS services for chat runs and memory capture |
| Ingress | ALB, ACM certificate, Route 53 |
| Domain | `app.comparative.example`; older `ai-workspace.comparative.example` retained as a legacy alias |
| Database | RDS Postgres |
| Secrets | AWS Secrets Manager target |
| Observability | CloudWatch logs, metrics, alarms, ALB health checks |
| IaC | CDK TypeScript in `infra/cdk` |
| Rollback | App Runner retained temporarily during cutover |

### Why ECS/Fargate

ECS/Fargate is a better fit for enterprise IT review than App Runner because it supports clearer worker isolation, IAM boundaries, networking control, observability, scaling posture, and future WAF/rate-limit hardening.

---

## 9. Security and Readiness Posture

This section summarizes known posture without pretending the system is production-cleared for broad enterprise use.

### Controls already present or partially present

- Authenticated app shell.
- Admin role separation.
- Encrypted provider tokens in Postgres.
- Provider-level MCP mount gates.
- Audit rows for tool and product actions.
- Redaction helper for tool payload persistence.
- Request size and message size limits.
- Shared fixed-window rate-limit buckets in schema.
- Health endpoint with DB/runtime configuration checks.
- No-secrets scan for app content.
- Restrictive app serving posture for thin Apps.
- CI with lint/typecheck/build/test.

### Known hardening still required

- Formal threat model.
- Enterprise SSO implementation and review.
- Lower-level MCP policy enforcement for specific tools/actions.
- Retention automation for chat, run output, audit, and logs.
- Shared quota store and daily token budgets.
- RDS Proxy/Aurora decision before broad concurrency.
- Dedicated VPC/private subnet posture.
- KMS-backed secret rotation plan.
- WAF/rate rules at the edge.
- Multi-task ECS smoke testing for rate limits and worker leases.
- Load testing at pilot, department, and enterprise scale.
- Dependency audit clean-state or formally accepted mitigations.

---

## 10. Enterprise Integration Roadmap

Current integration pattern is proven with GitHub MCP.

Planned or placeholder integrations:

| Integration | Pattern | Notes |
|---|---|---|
| GitHub | Delegated OAuth over HTTP MCP | Live |
| Microsoft 365 Graph | Delegated OAuth over HTTP MCP | Mail, Calendar, Files, Teams; requires enterprise app registration |
| Workfront | Delegated OAuth over HTTP MCP | Project/task/status workflows |
| Salesforce | Delegated OAuth over HTTP MCP | Account, opportunity, customer briefing workflows |
| Databricks / S3 / Redshift | Service principal / IAM; likely unified data-lake MCP | Data exploration workflows |
| ServiceNow | OAuth and/or service principal | IT request workflows |
| SAP | Spike-first | Strategic, auth and module-specific complexity expected |

---

## 11. Open Design Questions for IT Partners

1. What enterprise SSO path should be preferred: PingOne, PingFederate, or another OIDC standard?
2. What approval path is required for Microsoft Graph delegated permissions?
3. Should lower-level MCP policy be enforced through a central MCP proxy, provider-specific wrappers, or runtime hooks?
4. What data retention classes should apply to chat messages, tool inputs/results, run outputs, audit rows, and generated artifacts?
5. What enterprise KMS rotation policy is required for OAuth token encryption?
6. What network posture is required before pilot versus department rollout versus broad rollout?
7. Should RDS Postgres remain the database target, or should Aurora/RDS Proxy be mandated before department rollout?
8. What systems are approved for early integration beyond GitHub: M365, Workfront, Databricks, Salesforce, or ServiceNow?
9. What level of human confirmation is required for write-side tools such as send email, create ticket, update task, or deploy app?
10. What monitoring and cost controls are mandatory before expanding beyond a pilot group?

---

## 12. Suggested Review Sequence

Recommended order for enterprise partner review:

1. Product architecture and ownership boundary.
2. Identity and delegated-provider authorization model.
3. MCP integration pattern and tool governance.
4. Data model and retention classification.
5. ECS/Fargate deployment design.
6. Secrets/KMS/IaC posture.
7. Audit, redaction, and logging design.
8. Pilot load model and cost guardrails.
9. Full threat model and security review.

---

## 13. Bottom Line

Comparative is designed to make enterprise AI useful without making it uncontrolled.

The important architectural choices are:

- one governed front door;
- AWS-native runtime substrate;
- runtime abstraction through `AgentRuntime`;
- MCP as the integration standard;
- Skills as the reusable work primitive;
- Runs and Run Events as durable execution records;
- Shares that never transfer credentials;
- Apps that are workspace-authenticated from day one;
- explicit audit, redaction, and readiness posture;
- enterprise hardening deferred only where it is clearly identified.

The current system is appropriate for continued POC and pilot development. It should not be represented as fully enterprise production-ready until SSO, threat modeling, retention, lower-level tool policy, shared quotas, KMS/Secrets/IaC, network posture, and load testing are completed.
