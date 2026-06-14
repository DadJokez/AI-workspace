# Run Ledger Decision

Status: accepted for the current pilot.

## Decision

Keep one generalized run ledger for now. The existing `recipe_runs` table is the
durable record for chat-originated work, manual workflows, recipes, and future
scheduled jobs. Do not introduce a separate `agent_runs` table yet.

The product concept is simply **a run**:

- chat starts a run;
- a recipe starts a run;
- a schedule starts a run;
- a retry starts a linked run;
- a background worker executes or reconciles a run.

Recipes and schedules are trigger/configuration layers around that run. They do
not need a second lifecycle model.

## Why

This keeps the model understandable for users, admins, and IT:

- one place to answer "what is running, what failed, who started it, and why?";
- one status vocabulary: `queued`, `running`, `succeeded`, `failed`, `canceled`;
- one event stream for reloadable progress;
- one cancellation/retry/audit path;
- less migration churn before schedules and workers are proven.

`recipe_runs` is an imperfect table name, but it is already deployed and holds
the right core shape: user, thread, trigger, status, runtime/model, inputs,
outputs, error, and lifecycle timestamps. Renaming it before the worker and
scheduling paths harden would create noise without improving the product.

## Schema Direction

Use tables around `recipe_runs` rather than forking the run ledger:

| Need | Table / location |
|---|---|
| Run lifecycle | `recipe_runs` |
| Reloadable progress | `run_events.recipe_run_id` |
| Tool/compliance ledger | `audit_log.recipe_run_id` |
| Provider runtime ids | Short term: `recipe_runs.outputs.providerRun`; later: indexed provider columns if querying needs it |
| Generated files/artifacts | Future `run_artifacts.recipe_run_id` |
| Retry lineage | Short term: `recipe_runs.inputs.retryOfRunId`; later: indexed lineage column if needed |
| Schedule trigger | Future schedules table points at created `recipe_runs` rows |

If the table name becomes confusing once the catalog is live, do a deliberate
rename from `recipe_runs` to `runs` with a compatibility view. Do not split
chat and recipe execution into separate lifecycle systems.

## Impact On Open Work

#91 should add `run_events` keyed to `recipe_runs.id`. Events are append-only,
redacted, ordered, and reloadable by chat/admin surfaces.

#92 adds the first worker-backed execution path: chat creates queued
`recipe_runs`, a worker claims them with a lease, writes `run_events`, executes
or resumes the runtime run, and persists the terminal assistant message back
to `chat_messages`. The pilot keeps an in-process worker bridge so today's App
Runner service works immediately; ECS/Fargate should run the packaged worker
image for the enterprise deployment. SQS/EventBridge can replace direct DB
polling when scale or operational isolation requires it. Step Functions remains
an option if retry/wait-state audit requirements justify it.

#93 adds explicit lifecycle controls on top of that run model. Users can cancel
queued/running chat-originated runs and retry failed/canceled turns from chat.
Admins can cancel, retry, or request resume/reconcile from run detail. These
actions update `recipe_runs`, write `run_events`, and create `audit_log` rows;
Runtime cancellation is recorded in AI Hub and delegated to the provider when
the active runtime exposes a cancellation handle.

#27 should create schedule definitions that produce `recipe_runs` rows. It
should not invent a second run table or schedule-only execution path.

## Revisit Trigger

Revisit this decision only if one of these becomes true:

- query patterns require first-class provider ids or retry lineage at high
  volume;
- recipe catalog metadata overwhelms the neutral run fields;
- compliance asks for a clearer physical table name before production;
- multiple worker classes need materially different lifecycle semantics.
