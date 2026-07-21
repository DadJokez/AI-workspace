# Rollout Checklist: Runtime V2 Autopilot

**Purpose**: Validate Runtime V2 before and after production enablement.
**Created**: 2026-05-29
**Feature**: [Runtime V2 Autopilot](../spec.md)

## Preview Validation

- [x] CHK001 `https://runtime-v2.ai-workspace.comparative.example/api/health` returns healthy DB/runtime checks.
- [ ] CHK002 Preview GitHub OAuth callback is configured if browser login is required.
- [ ] CHK003 Simple prompt `say pong and nothing else` streams inline.
- [ ] CHK004 Simple prompt stores `lane = fast-local`, `runtimeTarget = direct-chat`, and `executionMode = local`.
- [ ] CHK005 Admin run detail shows first-token latency for the simple prompt.
- [ ] CHK006 GitHub prompt routes to `tool-local` and mounts GitHub only when connected/approved.
- [ ] CHK007 Durable prompt routes to `durable-local` and creates a worker-claimed run.
- [ ] CHK008 Legacy `executionMode = "cloud"` requests normalize to local execution.
- [ ] CHK009 Denied model access produces clear user/admin diagnostics or falls back to configured direct model.

## Production Enablement

- [x] CHK010 Production Runtime V2 config is reviewed before enabling.
- [ ] CHK011 Production web service receives `RUNTIME_V2_ENABLED=1`.
- [ ] CHK012 Production chat-worker and memory-worker remain healthy.
- [ ] CHK013 Production smoke covers simple, tool, durable, legacy cloud-normalization, and model fallback paths.
- [ ] CHK014 App Runner rollback remains available until Runtime V2 has a stable observation window.
- [x] CHK015 App Runner retirement criteria are documented before disabling rollback.

## Measurement

- [ ] CHK016 At least 20 fast-local runs have populated `requestToFirstTokenMs`.
- [ ] CHK017 Runtime V2 fast-local median and p95 first-token latency are compared with Runtime V1 queued-agent fast chat.
- [ ] CHK018 Tool-local first-token latency is measured separately from fast-local.
- [ ] CHK019 Failed runs are grouped by route lane and provider/model error class.

## Notes

- Check items off as completed: `[x]`.
- Link production smoke evidence to the GitHub rollout issue.

## Evidence: 2026-05-30

- Preview health returned `status = ok`, DB `ok = true`, runtime `configured = true`, runtime name `cursor`.
- Production health returned `status = ok`, DB `ok = true`, runtime `configured = true`, runtime name `cursor`.
- Runtime V2 ECS preview services were `ACTIVE` with desired `1`, running `1`, pending `0`, and rollout state `COMPLETED` for web, chat-worker, and memory-worker.
- Production ECS services were `ACTIVE` with desired `1`, running `1`, pending `0`, and rollout state `COMPLETED` for web, chat-worker, and memory-worker before the Runtime V2 production config change.
- Production config review result: promote the same direct Bedrock flags used by the preview stack into the production ECS stack and grant Bedrock invoke permission to the production chat worker.

## App Runner Rollback And Retirement Criteria

Keep App Runner available as rollback for at least 24 hours after Runtime V2 is deployed to production. Roll back to App Runner or a Runtime V2-disabled ECS task definition if any of these happen during the observation window:

- `/api/health` fails for production web or ECS cannot keep web, chat-worker, and memory-worker at desired `1`, running `1`, pending `0`.
- Fast-local simple chat cannot stream and complete, or successful fast-local runs stop recording `requestToFirstTokenMs`.
- Tool-local GitHub smoke, durable-local worker smoke, or legacy cloud-normalization smoke blocks normal user workflows.
- Model access denial/fallback diagnostics regress into confusing user-facing failures for normal chat.
- Memory capture develops a pending or failed backlog that does not clear after one scheduler interval.

Retire App Runner only after all of these are true:

- Production smoke is complete for simple fast-local, GitHub/tool-local, durable-local, legacy cloud-normalization, and model fallback paths.
- At least 20 production fast-local runs have populated `requestToFirstTokenMs`, with median and p95 recorded in issue #103.
- `/admin/runs` exposes route, runtime target, model, and first-token latency for production fast-local turns.
- ECS service health remains stable through the observation window and no rollback criteria are triggered.
- GitHub OAuth callbacks and `NEXTAUTH_URL` point at the ECS production domain.
