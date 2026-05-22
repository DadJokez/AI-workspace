import { getDb } from "@ai-workspace/db";
import { runMemoryCaptureWorkerLoop } from "../lib/memory-capture";

const workerId =
  process.env.MEMORY_CAPTURE_WORKER_ID ??
  `memory-capture-worker-${process.pid}-${Date.now()}`;
const controller = new AbortController();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    process.stderr.write(
      `[memory-capture-worker-stop] ${JSON.stringify({ workerId, signal })}\n`,
    );
    controller.abort();
  });
}

process.stderr.write(
  `[memory-capture-worker-start] ${JSON.stringify({ workerId })}\n`,
);

runMemoryCaptureWorkerLoop({
  db: getDb(),
  signal: controller.signal,
}).catch((err) => {
  process.stderr.write(
    `[memory-capture-worker-fatal] ${JSON.stringify({
      workerId,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    })}\n`,
  );
  process.exitCode = 1;
});
