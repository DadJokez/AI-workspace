import { encode } from "next-auth/jwt";
import {
  chatMessages,
  chatThreads,
  closeDb,
  getDb,
  memoryCaptureQueue,
  runs,
  users,
  workspaceArtifacts,
} from "@ai-workspace/db";
import { and, eq, inArray, lt, or } from "drizzle-orm";

import {
  buildProductionResourceFixtures,
  type ProductionResourceFixture,
} from "./conversation-resource-smoke-fixtures";
import { partitionResourceToolResults } from "./production-resource-smoke-results";
import { queryConversationResource } from "@/lib/conversation-resource-content";

const DEFAULT_BASE_URL = "https://comparative.builtwithrobot.link";
const SMOKE_USER_ID = "00000000-0000-4000-8000-000000000206";
const SMOKE_GH_SUB = "comparative-production-smoke";
const SMOKE_EMAIL = "comparative-smoke@example.com";
const SMOKE_NAME = "Comparative Smoke";

const resourceMatrixEnabled = process.argv.includes("--resource-matrix");
const baseUrl = normalizeBaseUrl(process.env.SMOKE_BASE_URL ?? DEFAULT_BASE_URL);
const timeoutMs = Number(
  process.env.SMOKE_AUTH_TIMEOUT_MS ??
    (resourceMatrixEnabled ? 180_000 : 90_000),
);
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
  uploadThreadId?: string;
  resourceMatrixThreadIds: string[];
  agentCoreThreadId?: string;
  agentCoreRunId?: string;
} = { resourceMatrixThreadIds: [] };

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
    await uploadContinuityCheck(db, cookie);
    if (resourceMatrixEnabled) {
      await conversationResourceMatrixCheck(db, cookie);
    }
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

async function conversationResourceMatrixCheck(
  db: ReturnType<typeof getDb>,
  cookie: string,
) {
  const fixtures = await buildProductionResourceFixtures(runId);
  const batches = chunk(fixtures, 5);
  let agentCoreProbe:
    | {
        threadId: string;
        fixture: ProductionResourceFixture;
        resourceId: string;
      }
    | undefined;

  for (const [batchIndex, batch] of batches.entries()) {
    const upload = await postChat(cookie, {
      message:
        "Store the attached production resource validation files in this conversation. Reply only with STORED.",
      attachmentCount: batch.length,
      attachments: batch.map((fixture) => ({
        name: fixture.filename,
        mimeType: fixture.mimeType,
        sizeBytes: fixture.bytes.byteLength,
        dataBase64: fixture.bytes.toString("base64"),
      })),
    });
    assertStatus(
      upload.response,
      200,
      `/api/chat resource matrix upload batch ${batchIndex + 1}`,
      upload.rawBody,
    );
    const uploadMeta = requiredChatMeta(
      upload.events,
      `resource matrix upload batch ${batchIndex + 1}`,
    );
    const threadId = uploadMeta.threadId;
    state.resourceMatrixThreadIds.push(threadId);
    await completedRun(db, uploadMeta.runId);

    const uploadResolution = recordField(
      uploadMeta,
      "resourceResolution",
      "resource matrix upload missing resolution",
    );
    const uploadedSelections = arrayField(
      uploadResolution,
      "selected",
      "resource matrix upload resolution missing selected resources",
    );
    assert(
      uploadResolution.status === "selected" &&
        uploadedSelections.length === batch.length,
      `resource matrix upload selected ${uploadedSelections.length}/${batch.length} resources`,
    );
    assert(
      uploadedSelections.every(
        (selection) =>
          isRecord(selection) && selection.reason === "current_upload",
      ),
      "resource matrix upload did not use current_upload resolver precedence",
    );

    const artifacts = await db
      .select()
      .from(workspaceArtifacts)
      .where(
        and(
          eq(workspaceArtifacts.userId, SMOKE_USER_ID),
          eq(workspaceArtifacts.threadId, threadId),
          eq(workspaceArtifacts.source, "user-upload"),
        ),
      );
    assert(
      artifacts.length === batch.length,
      `resource matrix stored ${artifacts.length}/${batch.length} artifacts in batch ${batchIndex + 1}`,
    );

    const uploadBatchIds = new Set<string>();
    for (const fixture of batch) {
      const artifact = artifacts.find(
        (candidate) => candidate.filename === fixture.filename,
      );
      assert(artifact, `missing stored resource ${fixture.filename}`);
      const metadata = recordField(
        artifact,
        "metadata",
        `${fixture.filename} metadata missing`,
      );
      const resourceMetadata = recordField(
        metadata,
        "conversationResource",
        `${fixture.filename} resource metadata missing`,
      );
      assert(
        resourceMetadata.resourceId === artifact.id,
        `${fixture.filename} resource id does not match its durable artifact id`,
      );
      assert(
        typeof resourceMetadata.uploadBatchId === "string",
        `${fixture.filename} upload batch id missing`,
      );
      uploadBatchIds.add(resourceMetadata.uploadBatchId);
      assert(
        typeof resourceMetadata.checksumSha256 === "string" &&
          /^[a-f0-9]{64}$/.test(resourceMetadata.checksumSha256),
        `${fixture.filename} checksum is missing or malformed`,
      );
      assert(
        resourceMetadata.lifecycleState === "available",
        `${fixture.filename} lifecycle is not available`,
      );
      assert(
        artifact.chatMessageId !== null,
        `${fixture.filename} is not associated with its source message`,
      );

      await verifyCompleteAdapter(fixture, artifact);
      await verifyLaterTurnReuse({
        db,
        cookie,
        threadId,
        fixture,
        resourceId: artifact.id,
      });
      if (fixture.extension === "csv") {
        agentCoreProbe = {
          threadId,
          fixture,
          resourceId: artifact.id,
        };
      }
    }
    assert(
      uploadBatchIds.size === 1,
      `resource matrix batch ${batchIndex + 1} did not retain one stable upload batch id`,
    );

    const storedAfterFollowUps = await db
      .select({ id: workspaceArtifacts.id })
      .from(workspaceArtifacts)
      .where(
        and(
          eq(workspaceArtifacts.userId, SMOKE_USER_ID),
          eq(workspaceArtifacts.threadId, threadId),
          eq(workspaceArtifacts.source, "user-upload"),
        ),
      );
    assert(
      storedAfterFollowUps.length === artifacts.length,
      `resource matrix follow-ups duplicated artifacts (${artifacts.length} -> ${storedAfterFollowUps.length})`,
    );
  }
  assert(agentCoreProbe, "resource matrix did not create an AgentCore CSV probe");
  await verifyLaterTurnReuse({
    db,
    cookie,
    ...agentCoreProbe,
    durable: true,
  });

  console.log(
    `ok conversationResourceMatrixCheck (${fixtures.length} formats, ${batches.length} upload batches)`,
  );
}

async function verifyCompleteAdapter(
  fixture: ProductionResourceFixture,
  artifact: typeof workspaceArtifacts.$inferSelect,
) {
  const resource = {
    id: artifact.id,
    filename: artifact.filename,
    mimeType: artifact.mimeType,
    kind: artifact.kind,
    content: artifact.content,
    sizeBytes: artifact.sizeBytes,
    metadata: artifact.metadata,
  };

  if (fixture.kind === "table") {
    const aggregate = await queryConversationResource(resource, {
      resourceId: resource.id,
      operation: "table_aggregate",
      column: "amount",
      aggregate: "sum",
    });
    const facts = await queryConversationResource(resource, {
      resourceId: resource.id,
      operation: "table_filter",
      filterColumn: "marker",
      filterOperator: "contains",
      filterValue: "FACT",
      limit: 3,
    });
    assert(
      aggregate.value === fixture.expectedAggregate,
      `${fixture.filename} complete aggregate expected ${fixture.expectedAggregate}, got ${String(aggregate.value)}`,
    );
    assertFullSourceReceipt(aggregate, fixture.filename);
    assertFullSourceReceipt(facts, fixture.filename);
    assertFactsPresent(JSON.stringify(facts), fixture);
    return;
  }

  if (fixture.kind === "image") {
    const image = await queryConversationResource(resource, {
      resourceId: resource.id,
      operation: "read",
    });
    assertFullSourceReceipt(image, fixture.filename);
    const imageMetadata = recordField(
      image,
      "image",
      `${fixture.filename} image metadata missing`,
    );
    assert(
      Number(imageMetadata.width) > 0 && Number(imageMetadata.height) > 0,
      `${fixture.filename} native dimensions missing`,
    );
    return;
  }

  const search = await queryConversationResource(resource, {
    resourceId: resource.id,
    operation: "search",
    query: "DURABLE_",
    limit: 10,
  });
  assertFullSourceReceipt(search, fixture.filename);
  assertFactsPresent(JSON.stringify(search), fixture);
}

async function verifyLaterTurnReuse({
  db,
  cookie,
  threadId,
  fixture,
  resourceId,
  durable = false,
}: {
  db: ReturnType<typeof getDb>;
  cookie: string;
  threadId: string;
  fixture: ProductionResourceFixture;
  resourceId: string;
  durable?: boolean;
}) {
  const aggregateInstruction =
    fixture.expectedAggregate === undefined
      ? ""
      : " Then report the exact sum of the complete amount column.";
  const followUp = await postChat(cookie, {
    threadId,
    message: `${
      durable ? "Keep working in the background. " : ""
    }Read ${fixture.filename} from this conversation. Return the three all-caps fact lines from its beginning, middle, and end in that order.${aggregateInstruction}`,
  });
  assertStatus(
    followUp.response,
    200,
    `/api/chat resource follow-up ${fixture.filename}`,
    followUp.rawBody,
  );
  const followUpMeta = requiredChatMeta(
    followUp.events,
    `resource follow-up ${fixture.filename}`,
  );
  if (durable) {
    const runtimeRoute = recordField(
      followUpMeta,
      "runtimeRoute",
      `${fixture.filename} AgentCore follow-up missing runtime route`,
    );
    assert(
      runtimeRoute.useWorker === true &&
        runtimeRoute.runtimeTarget === "agentcore-worker",
      `${fixture.filename} did not route the background resource turn to AgentCore`,
    );
  }
  const run = await completedRun(db, followUpMeta.runId);
  const assistantText =
    followUp.text ||
    (typeof run.outputs?.assistantText === "string"
      ? run.outputs.assistantText
      : "");
  assertFactsPresent(assistantText, fixture);
  if (fixture.expectedAggregate !== undefined) {
    assert(
      new RegExp(`\\b${fixture.expectedAggregate}\\b`).test(assistantText),
      `${fixture.filename} later turn omitted aggregate ${fixture.expectedAggregate}: ${assistantText.slice(0, 300)}`,
    );
  }
  if (durable) {
    assert(
      run.outputs.runtime === "agentcore",
      `${fixture.filename} durable resource run did not report AgentCore`,
    );
    const providerRun = recordField(
      run.outputs,
      "providerRun",
      `${fixture.filename} durable resource run missing provider metadata`,
    );
    assert(
      providerRun.runtime === "agentcore",
      `${fixture.filename} durable provider metadata did not report AgentCore`,
    );
  }

  const resolution = recordField(
    run.inputs,
    "resourceResolution",
    `${fixture.filename} run receipt missing resource resolution`,
  );
  const selected = arrayField(
    resolution,
    "selected",
    `${fixture.filename} run receipt missing selected resources`,
  );
  assert(
    resolution.status === "selected" && selected.length === 1,
    `${fixture.filename} later turn did not select exactly one resource`,
  );
  const selection = selected[0];
  assert(
    isRecord(selection) &&
      selection.resourceId === resourceId &&
      selection.reason === "explicit_filename" &&
      selection.coverage === "full",
    `${fixture.filename} later turn receipt selected the wrong resource or coverage`,
  );

  const toolResults = Array.isArray(run.outputs?.toolResults)
    ? run.outputs.toolResults
    : [];
  if (fixture.kind !== "image") {
    const resourceResults = partitionResourceToolResults(toolResults);
    assert(
      resourceResults.all.length > 0,
      `${fixture.filename} later turn did not persist a resource tool receipt`,
    );
    assert(
      resourceResults.successful.length > 0,
      `${fixture.filename} later turn did not complete a resource tool call`,
    );
    for (const result of resourceResults.all) {
      const output = recordField(
        result,
        "output",
        `${fixture.filename} resource tool output receipt missing`,
      );
      const persisted = JSON.stringify(output);
      assert(
        fixture.expectedFacts.every((fact) => !persisted.includes(fact)),
        `${fixture.filename} persisted file content instead of a compact receipt`,
      );
    }
    for (const result of resourceResults.successful) {
      const output = recordField(
        result,
        "output",
        `${fixture.filename} successful resource tool output receipt missing`,
      );
      assertFullSourceReceipt(output, fixture.filename);
    }
  }
}

function assertFullSourceReceipt(
  value: Record<string, unknown>,
  filename: string,
) {
  const receipt = recordField(
    value,
    "receipt",
    `${filename} complete-file receipt missing`,
  );
  assert(
    receipt.sourceCoverage === "full",
    `${filename} expected full source coverage, got ${String(receipt.sourceCoverage)}`,
  );
}

function assertFactsPresent(
  text: string,
  fixture: ProductionResourceFixture,
) {
  for (const fact of fixture.expectedFacts) {
    assert(
      text.includes(fact),
      `${fixture.filename} did not recover ${fact}: ${text.slice(0, 300)}`,
    );
  }
}

async function uploadContinuityCheck(db: ReturnType<typeof getDb>, cookie: string) {
  const marker = `UPLOAD-CONTINUITY-${runId}`;
  const targetBytes = Math.floor(3.8 * 1024 * 1024);
  const prefix = `marker,region,revenue\n${marker},North America,4200000\n`;
  const row = "filler,EMEA,100\n";
  const csv = (prefix + row.repeat(Math.ceil(targetBytes / row.length))).slice(
    0,
    targetBytes,
  );
  const bytes = Buffer.from(csv, "utf8");

  const first = await fetchTextWithTimeout("/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
    },
    body: JSON.stringify({
      message: "A CSV is attached. Reply with only: file received",
      attachmentCount: 1,
      attachments: [
        {
          name: `production-continuity-${runId}.csv`,
          mimeType: "text/csv",
          sizeBytes: bytes.byteLength,
          dataBase64: bytes.toString("base64"),
        },
      ],
    }),
  });
  assertStatus(first.response, 200, "/api/chat large upload");
  const firstEvents = parseSseEvents(first.body);
  const firstMeta = firstEvents.find((event) => event.type === "meta");
  assert(
    isRecord(firstMeta) && typeof firstMeta.threadId === "string",
    "large upload response missing thread id",
  );
  assert(
    firstEvents.some((event) => event.type === "persisted"),
    "large upload response was not persisted",
  );
  state.uploadThreadId = firstMeta.threadId;

  const storedBeforeFollowUp = await db
    .select({ id: workspaceArtifacts.id })
    .from(workspaceArtifacts)
    .where(
      and(
        eq(workspaceArtifacts.userId, SMOKE_USER_ID),
        eq(workspaceArtifacts.threadId, state.uploadThreadId),
        eq(workspaceArtifacts.source, "user-upload"),
      ),
    );
  assert(
    storedBeforeFollowUp.length === 1,
    `large upload stored ${storedBeforeFollowUp.length} artifacts instead of one`,
  );

  const followUp = await fetchTextWithTimeout("/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
    },
    body: JSON.stringify({
      threadId: state.uploadThreadId,
      message:
        "Analyze the uploaded CSV. Reply with only the unique UPLOAD-CONTINUITY marker from its first data row.",
    }),
  });
  assertStatus(followUp.response, 200, "/api/chat upload follow-up");
  const followUpEvents = parseSseEvents(followUp.body);
  const followUpMeta = followUpEvents.find((event) => event.type === "meta");
  assert(isRecord(followUpMeta), "upload follow-up missing meta event");
  assert(
    isRecord(followUpMeta.routeReceipt) &&
      isRecord(followUpMeta.routeReceipt.contextAvailability) &&
      followUpMeta.routeReceipt.contextAvailability.uploadedFilesAvailable === true,
    "upload follow-up route receipt did not report stored file context",
  );
  const assistantText = followUpEvents
    .filter((event) => event.type === "text-delta")
    .map((event) => (typeof event.delta === "string" ? event.delta : ""))
    .join("");
  assert(
    assistantText.includes(marker),
    `upload follow-up did not recover marker ${marker}: ${assistantText.slice(0, 240)}`,
  );
  assert(
    followUpEvents.some((event) => event.type === "persisted"),
    "upload follow-up response was not persisted",
  );
  const storedAfterFollowUp = await db
    .select({ id: workspaceArtifacts.id })
    .from(workspaceArtifacts)
    .where(
      and(
        eq(workspaceArtifacts.userId, SMOKE_USER_ID),
        eq(workspaceArtifacts.threadId, state.uploadThreadId),
        eq(workspaceArtifacts.source, "user-upload"),
      ),
    );
  assert(
    storedAfterFollowUp.length === storedBeforeFollowUp.length,
    `upload follow-up duplicated stored artifacts (${storedBeforeFollowUp.length} -> ${storedAfterFollowUp.length})`,
  );
  console.log("ok uploadContinuityCheck");
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
        runtimeRoute: {
          lane: "durable-local",
          executionMode: "local",
          runtimeTarget: "agentcore-worker",
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
  const maxAge = (resourceMatrixEnabled ? 60 : 20) * 60;
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

async function postChat(
  cookie: string,
  body: Record<string, unknown>,
): Promise<{
  response: Response;
  events: Array<Record<string, unknown>>;
  rawBody: string;
  text: string;
}> {
  const result = await fetchTextWithTimeout("/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
    },
    body: JSON.stringify(body),
  });
  const events = parseSseEvents(result.body);
  return {
    response: result.response,
    events,
    rawBody: result.body,
    text: events
      .filter((event) => event.type === "text-delta")
      .map((event) => (typeof event.delta === "string" ? event.delta : ""))
      .join(""),
  };
}

function requiredChatMeta(
  events: readonly Record<string, unknown>[],
  label: string,
): Record<string, unknown> & { threadId: string; runId: string } {
  const meta = events.find((event) => event.type === "meta");
  assert(
    isRecord(meta) &&
      typeof meta.threadId === "string" &&
      typeof meta.runId === "string",
    `${label} missing chat meta thread/run ids`,
  );
  return meta as Record<string, unknown> & {
    threadId: string;
    runId: string;
  };
}

async function completedRun(
  db: ReturnType<typeof getDb>,
  requestedRunId: string,
): Promise<{
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
}> {
  const deadline = Date.now() + Math.max(timeoutMs, agentCoreTimeoutMs);
  while (Date.now() < deadline) {
    const rows = await db
      .select({
        status: runs.status,
        inputs: runs.inputs,
        outputs: runs.outputs,
        error: runs.error,
      })
      .from(runs)
      .where(eq(runs.id, requestedRunId))
      .limit(1);
    const current = rows[0];
    assert(current, `run ${requestedRunId} disappeared`);
    if (current.status === "failed" || current.status === "canceled") {
      throw new Error(
        `run ${requestedRunId} ${current.status}: ${current.error ?? "unknown error"}`,
      );
    }
    if (current.status === "succeeded") {
      return {
        inputs: isRecord(current.inputs) ? current.inputs : {},
        outputs: isRecord(current.outputs) ? current.outputs : {},
      };
    }
    await delay(1_000);
  }
  throw new Error(`run ${requestedRunId} did not complete before timeout`);
}

function recordField(
  value: unknown,
  key: string,
  message: string,
): Record<string, unknown> {
  assert(isRecord(value), message);
  const field = value[key];
  assert(isRecord(field), message);
  return field;
}

function arrayField(
  value: unknown,
  key: string,
  message: string,
): unknown[] {
  assert(isRecord(value), message);
  const field = value[key];
  assert(Array.isArray(field), message);
  return field;
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
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

function assertStatus(
  response: Response,
  expected: number,
  label: string,
  responseBody?: string,
) {
  const bodyDetail = responseBody?.trim()
    ? `: ${responseBody.trim().replace(/\s+/g, " ").slice(0, 300)}`
    : "";
  assert(
    response.status === expected,
    `${label} expected ${expected}, got ${response.status}${bodyDetail}`,
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
