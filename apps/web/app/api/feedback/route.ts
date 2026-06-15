import {
  chatMessages,
  chatThreads,
  feedbackReports,
  getDb,
  runs,
  workspaceArtifacts,
} from "@ai-workspace/db";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/getSessionUser";
import { userScope } from "@/lib/auth/scope";

export const dynamic = "force-dynamic";

const REPORT_TYPES = new Set([
  "bug",
  "confusing_answer",
  "missing_feature",
  "performance",
  "other",
]);
const SEVERITIES = new Set(["low", "normal", "high"]);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY = 4000;
const MAX_EXPECTED = 2000;
const MAX_TITLE = 140;
const MAX_METADATA_JSON = 8_000;
const MAX_SCREENSHOT_DATA_URL = 1_500_000;
const ALLOWED_SCREENSHOT_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

interface FeedbackContext {
  threadId?: unknown;
  messageId?: unknown;
  runId?: unknown;
  artifactId?: unknown;
  [key: string]: unknown;
}

interface PostBody {
  type?: unknown;
  severity?: unknown;
  title?: unknown;
  body?: unknown;
  expected?: unknown;
  includeContext?: unknown;
  pageUrl?: unknown;
  userAgent?: unknown;
  viewport?: unknown;
  context?: FeedbackContext;
  screenshotDataUrl?: unknown;
  screenshotName?: unknown;
  screenshotMimeType?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function cleanExternalUrl(value: unknown): string | undefined {
  const raw = cleanString(value, 1000);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function cleanUuid(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return UUID_RE.test(trimmed) ? trimmed : undefined;
}

function titleFrom(body: string, title?: string): string {
  const source = title ?? body;
  const firstLine = source.split(/\r?\n/).find((line) => line.trim()) ?? source;
  const normalized = firstLine.replace(/\s+/g, " ").trim();
  return normalized.slice(0, MAX_TITLE) || "Feedback report";
}

type CleanMetadataResult =
  | { ok: true; value: Record<string, unknown> | undefined }
  | { ok: false };

function cleanMetadata(value: unknown): CleanMetadataResult {
  if (!isRecord(value)) return { ok: true, value: undefined };
  const serialized = JSON.stringify(value);
  if (serialized.length > MAX_METADATA_JSON) {
    return { ok: false };
  }
  return {
    ok: true,
    value: JSON.parse(serialized) as Record<string, unknown>,
  };
}

async function visibleThreadId({
  threadId,
  sessionUser,
}: {
  threadId?: string;
  sessionUser: { id: string; role: "admin" | "user" };
}): Promise<string | undefined | null> {
  if (!threadId) return undefined;
  const db = getDb();
  const rows = await db
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(
      and(eq(chatThreads.id, threadId), userScope(sessionUser, chatThreads.userId)),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

async function visibleMessageId({
  messageId,
  threadId,
}: {
  messageId?: string;
  threadId?: string;
}): Promise<string | undefined> {
  if (!messageId || !threadId) return undefined;
  const db = getDb();
  const rows = await db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(and(eq(chatMessages.id, messageId), eq(chatMessages.threadId, threadId)))
    .limit(1);
  return rows[0]?.id;
}

async function visibleRunId({
  runId,
  sessionUser,
}: {
  runId?: string;
  sessionUser: { id: string; role: "admin" | "user" };
}): Promise<string | undefined> {
  if (!runId) return undefined;
  const db = getDb();
  const rows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.id, runId), userScope(sessionUser, runs.userId)))
    .limit(1);
  return rows[0]?.id;
}

async function visibleArtifactId({
  artifactId,
  sessionUser,
}: {
  artifactId?: string;
  sessionUser: { id: string; role: "admin" | "user" };
}): Promise<string | undefined> {
  if (!artifactId) return undefined;
  const db = getDb();
  const rows = await db
    .select({ id: workspaceArtifacts.id })
    .from(workspaceArtifacts)
    .where(
      and(
        eq(workspaceArtifacts.id, artifactId),
        userScope(sessionUser, workspaceArtifacts.userId),
      ),
    )
    .limit(1);
  return rows[0]?.id;
}

export async function POST(req: Request) {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const reportType =
    typeof body.type === "string" && REPORT_TYPES.has(body.type)
      ? body.type
      : "bug";
  const severity =
    typeof body.severity === "string" && SEVERITIES.has(body.severity)
      ? body.severity
      : "normal";
  const reportBody = cleanString(body.body, MAX_BODY);
  if (!reportBody) {
    return NextResponse.json({ error: "body_required" }, { status: 400 });
  }

  const contextResult =
    body.includeContext === false
      ? ({ ok: true, value: undefined } as const)
      : cleanMetadata(body.context);
  const viewportResult = cleanMetadata(body.viewport);
  if (!contextResult.ok || !viewportResult.ok) {
    return NextResponse.json({ error: "metadata_too_large" }, { status: 413 });
  }
  const context = contextResult.value;
  const viewport = viewportResult.value;
  const threadCandidate = cleanUuid(context?.threadId);
  const visibleThread = await visibleThreadId({
    threadId: threadCandidate,
    sessionUser,
  });
  if (visibleThread === null) {
    return NextResponse.json({ error: "thread_not_found" }, { status: 404 });
  }

  if (
    typeof body.screenshotDataUrl === "string" &&
    body.screenshotDataUrl.length > MAX_SCREENSHOT_DATA_URL
  ) {
    return NextResponse.json({ error: "screenshot_too_large" }, { status: 413 });
  }
  const screenshotDataUrl = cleanString(
    body.screenshotDataUrl,
    MAX_SCREENSHOT_DATA_URL,
  );
  let screenshotMimeType = screenshotDataUrl
    ? cleanString(body.screenshotMimeType, 80)
    : undefined;
  if (screenshotDataUrl) {
    const match = /^data:([^;,]+);base64,/i.exec(screenshotDataUrl);
    const dataUrlMimeType = match?.[1]?.toLowerCase();
    const declaredMimeType = screenshotMimeType?.toLowerCase();
    if (
      !dataUrlMimeType ||
      !ALLOWED_SCREENSHOT_MIME_TYPES.has(dataUrlMimeType) ||
      (declaredMimeType !== undefined && declaredMimeType !== dataUrlMimeType)
    ) {
      return NextResponse.json({ error: "invalid_screenshot" }, { status: 400 });
    }
    screenshotMimeType = dataUrlMimeType;
  }

  const [chatMessageId, runId, artifactId] = await Promise.all([
    visibleMessageId({
      messageId: cleanUuid(context?.messageId),
      threadId: visibleThread,
    }),
    visibleRunId({
      runId: cleanUuid(context?.runId),
      sessionUser,
    }),
    visibleArtifactId({
      artifactId: cleanUuid(context?.artifactId),
      sessionUser,
    }),
  ]);

  const db = getDb();
  const inserted = await db
    .insert(feedbackReports)
    .values({
      userId: sessionUser.id,
      threadId: visibleThread,
      chatMessageId,
      runId,
      artifactId,
      type: reportType,
      severity,
      title: titleFrom(reportBody, cleanString(body.title, MAX_TITLE)),
      body: reportBody,
      expected: cleanString(body.expected, MAX_EXPECTED),
      pageUrl: cleanExternalUrl(body.pageUrl),
      userAgent: cleanString(body.userAgent, 500),
      viewport,
      context,
      screenshotDataUrl,
      screenshotName: cleanString(body.screenshotName, 180),
      screenshotMimeType,
    })
    .returning({
      id: feedbackReports.id,
      status: feedbackReports.status,
      createdAt: feedbackReports.createdAt,
    });

  const row = inserted[0]!;
  return NextResponse.json(
    {
      report: {
        id: row.id,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
      },
    },
    { status: 201 },
  );
}
