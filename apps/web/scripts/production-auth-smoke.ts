import { encode } from "next-auth/jwt";
import {
  chatMessages,
  chatThreads,
  closeDb,
  getDb,
  memoryCaptureQueue,
  runs,
  users,
} from "@ai-workspace/db";
import { and, eq, inArray, lt, or } from "drizzle-orm";

const DEFAULT_BASE_URL = "https://comparative.builtwithrobot.link";
const SMOKE_USER_ID = "00000000-0000-4000-8000-000000000206";
const SMOKE_GH_SUB = "comparative-production-smoke";
const SMOKE_EMAIL = "comparative-smoke@example.com";
const SMOKE_NAME = "Comparative Smoke";

const baseUrl = normalizeBaseUrl(process.env.SMOKE_BASE_URL ?? DEFAULT_BASE_URL);
const timeoutMs = Number(process.env.SMOKE_AUTH_TIMEOUT_MS ?? 90_000);
const agentCoreTimeoutMs = positiveNumber(
  process.env.SMOKE_AGENTCORE_TIMEOUT_MS,
  180_000,
);
const staleBacklogMs = positiveNumber(
  process.env.SMOKE_BACKLOG_STALE_MS,
  5 * 60_000,
);
const cleanupMode = process.env.SMOKE_AUTH_CLEANUP ?? "success";
const runId = safeRunId(process.env.SMOKE_RUN_ID ?? String(Date.now()));
const artifactFilename = `comparative-prod-smoke-${runId}.md`;

const state: {
  threadId?: string;
  runId?: string;
  artifactId?: string;
  agentCoreThreadId?: string;
  agentCoreRunId?: string;
} = {};

let passed = false;

async function main() {
  const db = getDb();
  await resetSmokeUser(db);
  await seedSmokeUser(db);

  const cookie = await smokeSessionCookie();

  try {
    await healthCheck();
    await meCheck(cookie);
    await isolationCheck(cookie, "before chat");
    await chatArtifactCheck(cookie);
    await artifactListCheck(cookie);
    await transcriptExportCheck(cookie);
    await agentCoreDurableLaneCheck(db);
    await workerBacklogCheck(db);
    passed = true;
    console.log(
      `\nproduction authenticated smoke passed for ${baseUrl} thread=${state.threadId} run=${state.runId} artifact=${state.artifactId} agentcoreRun=${state.agentCoreRunId}`,
    );
  } finally {
    if (cleanupMode === "always" || (cleanupMode === "success" && passed)) {
      await resetSmokeUser(db);
      console.log("cleaned production smoke user data");
    } else {
      console.log(
        `left production smoke data for debugging user=${SMOKE_USER_ID} thread=${state.threadId ?? "n/a"} run=${state.runId ?? "n/a"} artifact=${state.artifactId ?? "n/a"} agentcoreRun=${state.agentCoreRunId ?? "n/a"}`,
      );
    }
  }
}

async function healthCheck() {
  const { response, body } = await fetchJsonWithTimeout<{
    status?: string;
    checks?: { db?: { ok?: boolean }; runtime?: { ok?: boolean } };
  }>("/api/health");
  assertStatus(response, 200, "/api/health");
  assert(body.status === "ok", "health status is not ok");
  assert(body.checks?.db?.ok === true, "database health check is not ok");
  assert(body.checks?.runtime?.ok === true, "runtime health check is not ok");
  console.log("ok healthCheck");
}

async function meCheck(cookie: string) {
  const { response, body } = await fetchJsonWithTimeout<{
    user?: { id?: string; email?: string; role?: string; displayName?: string };
  }>("/api/me", {
    headers: { cookie },
  });
  assertStatus(response, 200, "/api/me");
  assert(body.user?.id === SMOKE_USER_ID, "smoke session resolved wrong user");
  assert(body.user?.email === SMOKE_EMAIL, "smoke session resolved wrong email");
  assert(body.user?.role === "user", "smoke user must stay locked to user role");
  console.log("ok meCheck");
}

async function isolationCheck(cookie: string, label: string) {
  const { response, body } = await fetchJsonWithTimeout<{
    threads?: Array<{ id?: string; userId?: string }>;
  }>("/api/threads?limit=20", {
    headers: { cookie },
  });
  assertStatus(response, 200, `/api/threads ${label}`);
  const threads = body.threads ?? [];
  assert(
    threads.every((thread) => thread.userId === SMOKE_USER_ID),
    `smoke user saw non-smoke thread during ${label}`,
  );
  console.log(`ok isolationCheck ${label}`);
}

async function chatArtifactCheck(cookie: string) {
  const message = [
    `Production smoke check ${runId}.`,
    `Reply with exactly one fenced markdown code block using filename="${artifactFilename}".`,
    'The file content must include "# Comparative production smoke" and "- signed-in artifact path ok".',
    "Do not include any other prose.",
  ].join(" ");

  const { response, body } = await fetchTextWithTimeout("/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
    },
    body: JSON.stringify({ message }),
  });
  assertStatus(response, 200, "/api/chat signed-in post");
  assert(
    response.headers.get("content-type")?.includes("text/event-stream") === true,
    "/api/chat did not return an event stream",
  );

  const events = parseSseEvents(body);
  const meta = events.find((event) => event.type === "meta");
  const model = events.find((event) => event.type === "model");
  const persisted = events.find((event) => event.type === "persisted");
  assert(isRecord(meta) && typeof meta.threadId === "string", "missing chat meta thread id");
  assert(isRecord(meta) && typeof meta.runId === "string", "missing chat meta run id");
  assert(meta.routingMode === "model-decided", "production chat did not use model-decided routing");
  assert(isRecord(meta.runtimeRoute), "chat meta missing runtime route");
  assert(meta.runtimeRoute.routingMode === "model-decided", "runtime route did not preserve model-decided mode");
  assert(meta.runtimeRoute.useMcp === true, "model-decided runtime did not mount account tools");
  assert(isRecord(model), "missing runtime model event");
  assert(model.modelId === "sonnet-4-6", "production chat did not run on Sonnet 4.6");
  assert(isRecord(model.modelSelection), "runtime model event missing selection receipt");
  assert(model.modelSelection.reason === "model_decided_sonnet", "runtime model selection was not model-decided Sonnet");
  state.threadId = meta.threadId;
  state.runId = meta.runId;

  assert(isRecord(persisted), "chat did not persist an assistant response");
  const artifacts = Array.isArray(persisted.artifacts)
    ? (persisted.artifacts as Array<Record<string, unknown>>)
    : [];
  const artifact = artifacts.find((item) => item.filename === artifactFilename);
  assert(artifact, `chat did not persist artifact ${artifactFilename}`);
  assert(typeof artifact.id === "string", "persisted smoke artifact missing id");
  state.artifactId = artifact.id;
  console.log("ok chatArtifactCheck");
}

async function artifactListCheck(cookie: string) {
  const { response, body } = await fetchJsonWithTimeout<{
    artifacts?: Array<{ id?: string; filename?: string; threadId?: string }>;
  }>("/api/workspace/artifacts?limit=20", {
    headers: { cookie },
  });
  assertStatus(response, 200, "/api/workspace/artifacts");
  const artifact = body.artifacts?.find(
    (item) =>
      item.id === state.artifactId &&
      item.filename === artifactFilename &&
      item.threadId === state.threadId,
  );
  assert(artifact, "generated smoke artifact did not appear in workspace artifacts");
  console.log("ok artifactListCheck");
}

async function transcriptExportCheck(cookie: string) {
  assert(state.threadId, "missing thread id before transcript export");
  const { response, body } = await fetchTextWithTimeout(
    `/api/threads/${state.threadId}/export`,
    { headers: { cookie } },
  );
  assertStatus(response, 200, "/api/threads/[id]/export");
  assert(
    response.headers.get("content-type")?.includes("text/markdown") === true,
    "thread export did not return markdown",
  );
  assert(body.includes(`# `), "thread export missing markdown heading");
  assert(body.includes(state.threadId), "thread export missing thread id");
  assert(body.includes(artifactFilename), "thread export missing artifact filename");
  console.log("ok transcriptExportCheck");
}

async function agentCoreDurableLaneCheck(db: ReturnType<typeof getDb>) {
  const prompt = `Production AgentCore tool-schema smoke ${runId}. Reply with a short confirmation.`;
  const threadRows = await db
    .insert(chatThreads)
    .values({
      userId: SMOKE_USER_ID,
      title: `AgentCore smoke ${runId}`,
      defaultModelId: "sonnet-4-6",
    })
    .returning({ id: chatThreads.id });
  const threadId = threadRows[0]!.id;
  state.agentCoreThreadId = threadId;

  const messageRows = await db
    .insert(chatMessages)
    .values({
      threadId,
      role: "user",
      content: prompt,
    })
    .returning({ id: chatMessages.id });
  const userMessageId = messageRows[0]!.id;

  const runRows = await db
    .insert(runs)
    .values({
      userId: SMOKE_USER_ID,
      threadId,
      skillSlug: "chat-turn",
      triggerType: "chat",
      status: "queued",
      modelId: "sonnet-4-6",
      inputs: {
        prompt,
        threadId,
        userMessageId,
        requestedByUserId: SMOKE_USER_ID,
        executionMode: "local",
        runtimeV2: false,
        runtimeRoute: {
          lane: "durable-local",
          executionMode: "local",
          runtimeTarget: "agentcore-worker",
          runtimeV2: false,
          useWorker: true,
          useMcp: true,
          includeVaultContext: true,
          // Mounting web__fetch_url makes Bedrock validate a real tool schema.
          reasons: ["web_fetch_url", "production_agentcore_smoke"],
        },
      },
    })
    .returning({ id: runs.id });
  const agentCoreRunId = runRows[0]!.id;
  state.agentCoreRunId = agentCoreRunId;

  const deadline = Date.now() + agentCoreTimeoutMs;
  while (Date.now() < deadline) {
    const rows = await db
      .select({
        status: runs.status,
        runtime: runs.runtime,
        outputs: runs.outputs,
        error: runs.error,
      })
      .from(runs)
      .where(eq(runs.id, agentCoreRunId))
      .limit(1);
    const current = rows[0];
    assert(current, "AgentCore smoke run disappeared");

    if (current.status === "failed" || current.status === "canceled") {
      throw new Error(
        `AgentCore smoke run ${current.status}: ${current.error ?? "unknown error"}`,
      );
    }
    if (current.status === "succeeded") {
      const outputs = isRecord(current.outputs) ? current.outputs : {};
      const providerRun = isRecord(outputs.providerRun)
        ? outputs.providerRun
        : {};
      assert(current.runtime === "agentcore", "durable smoke used the wrong runtime");
      assert(
        providerRun.runtime === "agentcore",
        "durable smoke provider metadata did not report AgentCore",
      );
      assert(
        typeof outputs.assistantText === "string" && outputs.assistantText.length > 0,
        "AgentCore smoke returned no assistant text",
      );
      console.log("ok agentCoreDurableLaneCheck");
      return;
    }

    await delay(1_000);
  }

  throw new Error(
    `AgentCore smoke run did not finish within ${agentCoreTimeoutMs}ms`,
  );
}

async function workerBacklogCheck(db: ReturnType<typeof getDb>) {
  const staleBefore = new Date(Date.now() - staleBacklogMs);
  const badRuns = await db
    .select({
      id: runs.id,
      status: runs.status,
      error: runs.error,
      createdAt: runs.createdAt,
    })
    .from(runs)
    .where(
      and(
        eq(runs.userId, SMOKE_USER_ID),
        or(
          eq(runs.status, "failed"),
          and(
            inArray(runs.status, ["queued", "running"]),
            lt(runs.createdAt, staleBefore),
          ),
        ),
      ),
    )
    .limit(10);

  const badMemoryRows = await db
    .select({
      id: memoryCaptureQueue.id,
      status: memoryCaptureQueue.status,
      error: memoryCaptureQueue.error,
      attemptCount: memoryCaptureQueue.attemptCount,
      createdAt: memoryCaptureQueue.createdAt,
      claimedAt: memoryCaptureQueue.claimedAt,
    })
    .from(memoryCaptureQueue)
    .where(
      and(
        eq(memoryCaptureQueue.userId, SMOKE_USER_ID),
        or(
          eq(memoryCaptureQueue.status, "failed"),
          and(
            inArray(memoryCaptureQueue.status, ["pending", "processing"]),
            lt(memoryCaptureQueue.createdAt, staleBefore),
          ),
        ),
      ),
    )
    .limit(10);

  assert(
    badRuns.length === 0,
    `smoke user has bad run backlog: ${JSON.stringify(badRuns)}`,
  );
  assert(
    badMemoryRows.length === 0,
    `smoke user has bad memory backlog: ${JSON.stringify(badMemoryRows)}`,
  );
  console.log("ok workerBacklogCheck");
}

async function seedSmokeUser(db: ReturnType<typeof getDb>) {
  await db.insert(users).values({
    id: SMOKE_USER_ID,
    pingSubject: SMOKE_GH_SUB,
    email: SMOKE_EMAIL,
    displayName: SMOKE_NAME,
    role: "user",
    defaultModelId: "sonnet-4-6",
    assistantName: "Thomas",
    tourCompletedAt: new Date(),
  });
}

async function resetSmokeUser(db: ReturnType<typeof getDb>) {
  await db.delete(users).where(eq(users.id, SMOKE_USER_ID));
}

async function smokeSessionCookie() {
  const secret = process.env.NEXTAUTH_SECRET;
  assert(secret && secret.length >= 32, "NEXTAUTH_SECRET is required for authenticated smoke");
  const maxAge = 20 * 60;
  const expires = Math.floor(Date.now() / 1000) + maxAge;
  const token = await encode({
    secret,
    maxAge,
    token: {
      sub: SMOKE_GH_SUB,
      ghSub: SMOKE_GH_SUB,
      userId: SMOKE_USER_ID,
      role: "user",
      email: SMOKE_EMAIL,
      name: SMOKE_NAME,
      iat: Math.floor(Date.now() / 1000),
      exp: expires,
    },
  });
  const cookieName = baseUrl.startsWith("https://")
    ? "__Secure-next-auth.session-token"
    : "next-auth.session-token";
  return `${cookieName}=${token}`;
}

async function fetchJsonWithTimeout<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: T }> {
  return fetchAndReadWithTimeout(path, init, async (response) => {
    return (await response.json()) as T;
  });
}

async function fetchTextWithTimeout(
  path: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: string }> {
  return fetchAndReadWithTimeout(path, init, (response) => response.text());
}

async function fetchAndReadWithTimeout<T>(
  path: string,
  init: RequestInit,
  readBody: (response: Response) => Promise<T>,
): Promise<{ response: Response; body: T }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: controller.signal,
    });
    const body = await readBody(response);
    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

function parseSseEvents(text: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const block of text.split(/\n\n+/)) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .join("\n");
    if (!data) continue;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (isRecord(parsed)) events.push(parsed);
    } catch {
      throw new Error(`invalid SSE JSON payload: ${data.slice(0, 120)}`);
    }
  }
  return events;
}

function normalizeBaseUrl(raw: string) {
  return raw.replace(/\/+$/, "");
}

function safeRunId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 64) || "manual";
}

function positiveNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertStatus(response: Response, expected: number, label: string) {
  assert(
    response.status === expected,
    `${label} expected ${expected}, got ${response.status}`,
  );
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function closeDbForExit() {
  try {
    await closeDb();
  } catch (err) {
    console.error(
      err instanceof Error
        ? `failed to close smoke DB client: ${err.message}`
        : "failed to close smoke DB client",
    );
  }
}

main()
  .then(async () => {
    await closeDbForExit();
    process.exit(0);
  })
  .catch(async (err) => {
    await closeDbForExit();
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    console.error(
      `production authenticated smoke failed for ${baseUrl} user=${SMOKE_USER_ID} thread=${state.threadId ?? "n/a"} run=${state.runId ?? "n/a"} artifact=${state.artifactId ?? "n/a"} agentcoreRun=${state.agentCoreRunId ?? "n/a"}`,
    );
    process.exit(1);
  });
