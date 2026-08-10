# Governed Custom Agents for Comparative

**Status:** Planning spec - no implementation
**Date:** 2026-08-09
**Research reference:** [Omnigent custom agents](https://github.com/omnigent-ai/omnigent/blob/main/docs/AGENT_YAML_SPEC.md), reviewed read-only at commit `c2167000`
**Product intent:** Let knowledge workers create durable specialists without exposing model, harness, credential, or MCP configuration.

## 0. GitHub Tracking

**Epic:** [#736 - Governed Custom Agents: durable specialists for knowledge work](https://github.com/DadJokez/AI-workspace/issues/736)

| Track | Issue |
| --- | --- |
| Agent contract, Agent/Skill boundary, and runtime compiler | [#745](https://github.com/DadJokez/AI-workspace/issues/745) |
| Natural-language builder and test-before-publish loop | [#746](https://github.com/DadJokez/AI-workspace/issues/746) |
| Per-user capabilities, memory, policy, and readiness | [#747](https://github.com/DadJokez/AI-workspace/issues/747) |
| Versions, sharing, catalog, and eval-gated publishing | [#748](https://github.com/DadJokez/AI-workspace/issues/748) |

## 1. Decision

Comparative should introduce a first-class **Agent** above the existing Skill primitive.

- **Comparative** is the general assistant and default Agent.
- An **Agent** is a durable specialist: identity, mission, default context, capability requirements, memory scope, policy profile, Skills, and output expectations.
- A **Skill** is a reusable procedure: how to perform a particular task.
- A **Thread** is one conversation with an Agent.
- A **Run** is one execution in a thread, schedule, event, or workflow.
- A **Worker** is an internal runtime role used to execute part of a run. Ordinary users do not configure or see workers as separate vendor agents.
- An **Artifact** or **App** is an output, not an Agent.

This gives the product a stable grammar:

> Agents know a job. Skills know a method. Tools provide capability. Memory provides context. Runs do the work.

The initial release must not rename or invalidate existing Skills. Skills remain independently runnable by Comparative and become composable capabilities an Agent can use.

## 2. What to Learn From Omnigent

Omnigent treats an agent definition separately from a running session. Its declarative spec can define identity, instructions, runtime, tools, policies, parameters, sandbox/OS access, terminals, async/cancel behavior, and subagents. A session is an instance of that definition. See the [Agent YAML specification](https://github.com/omnigent-ai/omnigent/blob/main/docs/AGENT_YAML_SPEC.md).

Useful patterns for Comparative:

- a versioned, declarative definition rather than behavior scattered across UI state;
- a clear difference between the definition and each conversation/run;
- capabilities derived from the definition, so unsupported UI is hidden;
- tools, policies, memory, and workers scoped per Agent;
- independently testable Agents;
- reusable Skills bundled with or selected by an Agent;
- optional specialist workers with isolated context; and
- readiness indicators before a user starts work.

Patterns not to adopt directly:

- harness or model fields in the normal authoring UI;
- raw MCP URLs, commands, environment variables, or credentials;
- an inheritance default that silently grants every parent tool;
- arbitrary unsandboxed OS access;
- YAML as the primary experience for knowledge workers; or
- multi-vendor identity as part of the Agent's user-facing identity.

Omnigent's current builder asks technical users for a harness, model, instructions, and MCP servers. Comparative should retain the declarative result while replacing that form with guided, natural-language authoring. Reference: [Omnigent Create Agent dialog](https://github.com/omnigent-ai/omnigent/blob/main/web/src/shell/CreateAgentDialog.tsx).

## 3. Agent Definition Contract

Comparative needs one internal, versioned Agent manifest. Postgres remains the system of record; a JSON representation is the runtime and import/export contract. Users do not hand-edit it in P0.

Conceptual shape:

```json
{
  "schemaVersion": 1,
  "identity": {
    "name": "Account Strategist",
    "description": "Prepares customer briefs and identifies account risk.",
    "avatar": "comparative-orb",
    "starterPrompts": []
  },
  "instructions": {
    "mission": "...",
    "standingRules": [],
    "outputContract": "..."
  },
  "capabilities": {
    "providers": [],
    "categories": [],
    "actionLevels": []
  },
  "skills": [],
  "memory": {
    "readScopes": [],
    "writeScope": "user",
    "capturePolicy": "suggest"
  },
  "policyProfile": "guided",
  "execution": {
    "allowedModes": ["interactive", "background"],
    "runtimeLane": "auto"
  },
  "sharing": {
    "visibility": "private"
  }
}
```

The manifest stores capability **requirements**, never OAuth tokens. At run time, Comparative resolves requirements through the current user's connections, attestations, catalog policy, and effective Agent/session policy.

The manifest does not pin a public model by default. The model qualification registry and runtime router choose an enabled lane appropriate to the task. An admin-only diagnostic view may show the resolved model and runtime.

### 3.1 Definition versus runtime instance

An Agent version is immutable once published. Starting a thread pins the version used at creation. Each run records:

- Agent id and version;
- selected Skill ids and versions;
- effective capability manifest;
- effective policy profile;
- context and memory receipt;
- runtime/model route;
- parent/child run lineage; and
- output/evidence references.

Editing an Agent creates a new draft version. Existing threads do not silently change behavior. The user may explicitly upgrade a thread or begin a new one on the latest version.

### 3.2 Compilation, not a second runtime

Comparative should not build a separate Agent execution engine.

```text
Agent version
  + selected Skill version
  + current user's authorized capabilities
  + thread/task context
  + effective policies
  -> runtime manifest
  -> existing AgentRuntime / runs / run_events path
```

The default Comparative assistant compiles through the same path using the system-owned default Agent definition.

## 4. Agent and Skill Boundary

| Question | Agent | Skill |
| --- | --- | --- |
| What is it? | A durable specialist | A reusable procedure |
| Owns a name/persona? | Yes | No, beyond catalog identity |
| Owns threads? | Yes | No; runs inside an Agent or Comparative thread |
| Owns memory defaults? | Yes, within policy | No |
| Declares capability requirements? | Yes | Yes, narrowed for the procedure |
| Can be scheduled? | Through a scheduled task assigned to the Agent and Skill | Yes, existing scheduling remains valid |
| Can be shared/published? | Yes | Yes |
| Can invoke Skills? | Yes | No recursive Skill graph in P0 |
| Can use internal workers? | Later, through governed orchestration | No direct worker configuration in P0 |

Existing Skills continue to run exactly as they do today under the default Comparative Agent. A user may choose **Create Agent from this Skill** when the workflow needs persistent identity, context, or a collection of related Skills.

## 5. Authoring Experience

### 5.1 Entry points

- **Create Agent** from the Agents surface.
- **Turn this into an Agent** after a successful chat or Skill run.
- **Create Agent from Skill** from a Skill detail page.
- An admin may publish approved starter Agents for roles or teams.

### 5.2 Guided builder

The builder asks business questions rather than implementation questions:

1. What job should this Agent own?
2. What information should it use?
3. Which connected systems does it need?
4. What may it read, prepare, or change?
5. What should its output look like?
6. What should always require approval?
7. What should it remember, and for whom?
8. Should it run only when asked, in the background, or on an existing schedule/event?

Comparative proposes a manifest and shows a plain-language capability card:

```text
Account Strategist

Uses: Salesforce read, Gmail read, Calendar read
Creates: briefs and draft emails
Cannot: send email or update Salesforce
Memory: your approved account preferences
Runs: when asked
```

Advanced technical configuration belongs in an admin/debug view, not the normal builder.

### 5.3 Test before publish

Every draft Agent has a Test surface:

- sample prompt and expected outcome;
- current user's live connections or safe fixtures;
- dry-run mode that blocks writes;
- visible context/capability receipt;
- work trace and outputs;
- policy and approval simulation;
- cost/latency summary; and
- save a successful run as a regression case.

Publishing should not be the first time an Agent executes.

## 6. Capability Binding and Readiness

An Agent declares what it needs by provider/category/action, not raw tool identifiers when a stable category exists.

Before a user starts a thread, Comparative computes readiness:

- **Ready** - every required capability is connected, attested, enabled, and policy-allowed.
- **Limited** - optional capabilities are missing; the Agent can still run with an explicit limitation.
- **Needs connection** - the user must connect a provider.
- **Needs approval** - a user or admin attestation is required.
- **Blocked** - organization policy prohibits a required capability.
- **Unavailable** - no qualified runtime/model supports a required modality or contract.

Readiness is per user. Sharing an Agent never transfers credentials or attestations. The recipient sees what they must connect and runs with their own identity.

Least-privilege rules:

- capability inheritance is deny-by-default;
- the Agent's requirements are intersected with the selected Skill, user attestation, and admin catalog policy;
- write/admin actions remain deterministic policy decisions;
- workers receive an explicit context and tool slice, never the full parent capability set by default; and
- missing capability produces an honest limitation or approval step, not tool hallucination.

## 7. Memory and Context

Agents may define memory defaults only within the memory architecture tracked by #413.

P0 rules:

- no Agent-private memory silently shared across users;
- personal Agents may read approved user memory;
- team/org memory requires the corresponding authorization scope;
- memory writes follow `off | suggest | automatic` policy, with `suggest` as the default;
- every turn carries a context receipt showing Agent, Skill, resources, and memory scopes; and
- changing Agent versions does not rewrite historical memory provenance.

An Agent's mission and standing rules are versioned instructions, not memory. Facts learned from work belong in a governed memory scope with provenance and lifecycle controls.

## 8. Policies, Budgets, and Approvals

Effective policy combines:

1. organization policy;
2. Agent-version policy profile;
3. selected Skill requirements;
4. session/task restrictions; and
5. action-level approval.

Most restrictive wins. Agent authors cannot weaken organization policy. A published Agent's capability card must identify writes, external communication, data export, background execution, and memory writes before adoption.

Per-run and per-Agent budgets should ride #493 and #734. Reaching a budget creates a truthful partial-result receipt and never silently changes the task's requested output or claims completion.

## 9. Workers and Multi-agent Composition

Omnigent allows an Agent to declare subagents with their own tools, model, context, and limits. The useful Comparative translation is **internal specialist workers**, not a user-facing team of vendor agents.

P0 custom Agents are single-orchestrator definitions. They may use the existing tool loop and Skills.

Later, after #422 and #423:

- the orchestrator may delegate to read-only data, research, build, or verify workers;
- each worker receives a bounded task brief and minimum capability set;
- only structured results/evidence return to the parent;
- one writer owns any mutable output;
- independent verification may inspect evidence without inheriting the writer's context; and
- the user sees labeled Work Map steps rather than worker model identities.

Omnigent's Scribe and Sentinel examples illustrate a valuable pattern: one orchestrator authors the result, a read-only specialist gathers evidence, and an independent reviewer checks it. Comparative can reproduce the maker/checker pattern entirely on approved AWS Bedrock lanes. References: [Scribe](https://github.com/omnigent-ai/omnigent/blob/main/examples/scribe/config.yaml) and [Sentinel](https://github.com/omnigent-ai/omnigent/blob/main/examples/sentinel/config.yaml).

## 10. Versioning, Sharing, and Catalog

Lifecycle:

`draft -> testing -> published -> deprecated -> archived`

Rules:

- published versions are immutable;
- adopters and threads pin a version;
- updates show a plain-language manifest diff;
- capability expansion always requires re-review;
- write/admin capability changes require the strongest review path;
- team/org publishing uses the vetting and namespacing work in #412 and #495;
- recipients execute with their own credentials and policy; and
- usage, quality, freshness, and provenance are visible in the catalog.

Agent evaluation should reuse the model/Skill qualification substrate:

- deterministic manifest and tool-scope checks;
- should-handle and should-not-handle routing cases;
- expected output-contract checks;
- policy violation probes;
- connector and file fixture tests;
- calibrated semantic judges over saved regression cases; and
- runtime conformance status for required modalities.

## 11. Architecture Dependencies

- #410 - deterministic tool policy and connection lifecycle.
- #412 - versioning, vetting, and namespacing rails.
- #413 - memory scopes and provenance.
- #422 - optional internal worker pipeline.
- #423 - parent/child runs and cost/audit spine.
- #436 - named policy/autonomy presets.
- #438 - layered standing instructions.
- #493 - verification, replay, and per-run budgets.
- #495 - org catalog and eval-gated publishing.
- #734 - cross-tool spend dashboard and progressive gates.
- Contribution Studio Context Shelf, Work Map, and conformance tracks.

## 12. Delivery Slices

### Slice A - Contract and grammar

- settle Agent versus Skill ownership;
- define manifest schema and compiler boundary;
- define version pinning and run provenance;
- represent the system default Comparative Agent; and
- produce an implementation decision on reuse versus a new persistence table.

### Slice B - Builder and test loop

- natural-language guided builder;
- create from chat/Skill;
- capability card and starter prompts;
- dry-run Test surface; and
- save successful tests as regression cases.

### Slice C - Governed capabilities and readiness

- capability requirements and per-user readiness;
- connection/attestation remediation;
- memory and policy profile binding;
- plain-language limitations; and
- runtime compilation into the existing execution path.

### Slice D - Lifecycle and distribution

- version/diff/update flow;
- sharing with recipient credentials;
- team/org catalog integration;
- vetting and scorecards; and
- deprecation/archive behavior.

## 13. Success Measures

- a non-technical user can create and test a useful Agent without seeing a model, harness, MCP URL, or credential;
- every Agent run records the exact Agent/Skill versions and effective capability manifest;
- shared Agents never transfer credentials or silently widen access;
- users understand why an Agent is ready, limited, or blocked before starting;
- published Agent updates never silently change existing threads;
- Agent regression cases catch behavior or policy drift before publication; and
- internal workers improve evidence quality without making the product feel like a multi-agent control panel.

## 14. Non-goals

- importing Omnigent agent YAML directly in P0;
- arbitrary executable tools or bundled scripts;
- user-selected models or harnesses;
- unrestricted terminals or operating-system access;
- recursive user-authored agent teams;
- shared cross-user memory by default;
- automatic update of published Agents without review; and
- a second execution/runtime stack alongside `AgentRuntime`.
