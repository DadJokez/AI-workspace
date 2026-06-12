import { getDb } from "@ai-workspace/db";
import { runChatRunWorkerLoop } from "../lib/chat-run-worker";
import { runSchedulerLoop } from "../lib/schedules/scheduler";

const workerId =
  process.env.CHAT_RUN_WORKER_ID ??
  `chat-run-worker-${process.pid}-${Date.now()}`;
const controller = new AbortController();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    process.stderr.write(
      `[chat-run-worker-stop] ${JSON.stringify({ workerId, signal })}\n`,
    );
    controller.abort();
  });
}

process.stderr.write(
  `[chat-run-worker-start] ${JSON.stringify({ workerId })}\n`,
);

const db = getDb();

runChatRunWorkerLoop({
  db,
  workerId,
  signal: controller.signal,
}).catch((err) => {
  process.stderr.write(
    `[chat-run-worker-fatal] ${JSON.stringify({
      workerId,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    })}\n`,
  );
  process.exitCode = 1;
});

// The scheduler tick shares this process (specs/002-skills-spine plan: no
// new service). It only enqueues runs; the loop above executes them.
runSchedulerLoop({
  db,
  workerId,
  signal: controller.signal,
}).catch((err) => {
  process.stderr.write(
    `[scheduler-fatal] ${JSON.stringify({
      workerId,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    })}\n`,
  );
  process.exitCode = 1;
});
