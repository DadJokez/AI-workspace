# Rollout Checklist: Runtime V2 Autopilot

**Purpose**: Validate Runtime V2 before and after production enablement.
**Created**: 2026-05-29
**Feature**: [Runtime V2 Autopilot](../spec.md)

## Preview Validation

- [ ] CHK001 `https://runtime-v2.ai-workspace.builtwithrobot.link/api/health` returns healthy DB/runtime checks.
- [ ] CHK002 Preview GitHub OAuth callback is configured if browser login is required.
- [ ] CHK003 Simple prompt `say pong and nothing else` streams inline.
- [ ] CHK004 Simple prompt stores `lane = fast-local`, `runtimeTarget = direct-chat`, and `executionMode = local`.
- [ ] CHK005 Admin run detail shows first-token latency for the simple prompt.
- [ ] CHK006 GitHub prompt routes to `tool-local` and mounts GitHub only when connected/approved.
- [ ] CHK007 Durable prompt routes to `durable-local` and creates a worker-claimed run.
- [ ] CHK008 One-shot Cloud prompt routes to `cursor-cloud`, then next prompt defaults back to local.
- [ ] CHK009 Denied model access produces clear user/admin diagnostics or falls back to configured direct model.

## Production Enablement

- [ ] CHK010 Production Runtime V2 config is reviewed before enabling.
- [ ] CHK011 Production web service receives `RUNTIME_V2_ENABLED=1`.
- [ ] CHK012 Production chat-worker and memory-worker remain healthy.
- [ ] CHK013 Production smoke covers simple, tool, durable, cloud, and model fallback paths.
- [ ] CHK014 App Runner rollback remains available until Runtime V2 has a stable observation window.
- [ ] CHK015 App Runner retirement criteria are documented before disabling rollback.

## Measurement

- [ ] CHK016 At least 20 fast-local runs have populated `requestToFirstTokenMs`.
- [ ] CHK017 Runtime V2 fast-local median and p95 first-token latency are compared with Runtime V1 Cursor-agent fast chat.
- [ ] CHK018 Tool-local first-token latency is measured separately from fast-local.
- [ ] CHK019 Failed runs are grouped by route lane and provider/model error class.

## Notes

- Check items off as completed: `[x]`.
- Link production smoke evidence to the GitHub rollout issue.
