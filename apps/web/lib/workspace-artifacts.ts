import {
  auditLog,
  type Database,
  workspaceArtifacts,
  type WorkspaceArtifact,
} from "@ai-workspace/db";
import { and, desc, eq, or } from "drizzle-orm";
import {
  planArtifactVersionsForExistingArtifacts,
  sanitizeArtifactFilename as sanitizeFilename,
  type PlannedArtifactVersion,
  type WorkspaceArtifactVersionTarget,
} from "@/lib/artifact-revisions";
import { scrubBindingsForClient } from "@/lib/app-data-bindings";
import { deriveBindingsFromTurnTools } from "@/lib/app-data-bootstrap";
import { computeLineDelta } from "@/lib/artifact-diff";
import type { ToolCall, ToolResult } from "@ai-workspace/agent";

const MAX_ARTIFACTS_PER_MESSAGE = 5;
const MAX_ARTIFACT_CHARS = 500_000;
const MIN_IMPLICIT_ARTIFACT_CHARS = 240;
const MIN_DECLARED_TEXT_ARTIFACT_CHARS = 80;

export interface WorkspaceArtifactSummary {
  id: string;
  title: string;
  filename: string;
  kind: string;
  mimeType: string;
  sizeBytes: number;
  source: string;
  threadId: string | null;
  chatMessageId: string | null;
  runId: string | null;
  artifactGroupId: string;
  versionNumber: number;
  supersedesArtifactId: string | null;
  versionSummary: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  previewUrl: string;
  downloadUrl: string;
}

export interface WorkspaceArtifactDetail extends WorkspaceArtifactSummary {
  content: string;
}

interface CreateArtifactsInput {
  db: Database;
  userId: string;
  threadId: string;
  chatMessageId: string;
  runId?: string | null;
  assistantText: string;
  targetArtifact?: WorkspaceArtifactVersionTarget | null;
  separateFromArtifact?: WorkspaceArtifactVersionTarget | null;
  /**
   * The minting turn's tool activity (#407): successful run_soql calls
   * become pinned dataBindings on servable HTML artifacts, so "share as a
   * live app" works without the user asking for wiring.
   */
  turnToolCalls?: readonly ToolCall[];
  turnToolResults?: readonly ToolResult[];
}

export interface ParsedArtifact {
  title: string;
  filename: string;
  kind: string;
  mimeType: string;
  content: string;
  metadata: Record<string, unknown>;
}

interface FencedCodeBlock {
  info: string;
  language: string;
  content: string;
  closed: boolean;
}

export async function createArtifactsFromAssistantMessage({
  db,
  userId,
  threadId,
  chatMessageId,
  runId,
  assistantText,
  targetArtifact,
  separateFromArtifact,
  turnToolCalls,
  turnToolResults,
}: CreateArtifactsInput): Promise<WorkspaceArtifactSummary[]> {
  const parsed = parseAssistantArtifacts(assistantText);
  if (parsed.length === 0) return [];
  const derivedBindings = deriveBindingsFromTurnTools(
    turnToolCalls,
    turnToolResults,
  );
  const { planned, priorContentById } = await planArtifactVersions({
    db,
    userId,
    threadId,
    artifacts: parsed,
    targetArtifact,
    separateFromArtifact,
  });

  const rows = await db
    .insert(workspaceArtifacts)
    .values(
      planned.map(({ artifact, version }) => ({
        userId,
        threadId,
        chatMessageId,
        runId: runId ?? null,
        title: version.title ?? artifact.title,
        filename: version.filename,
        artifactGroupId: version.artifactGroupId,
        versionNumber: version.versionNumber,
        supersedesArtifactId: version.supersedesArtifactId,
        versionSummary: version.versionSummary,
        kind: artifact.kind,
        mimeType: artifact.mimeType,
        content: artifact.content,
        sizeBytes: Buffer.byteLength(artifact.content, "utf8"),
        source: "assistant-code-block",
        metadata: {
          ...artifact.metadata,
          artifactKey: version.artifactKey,
          originalFilename: artifact.filename,
          versionNumber: version.versionNumber,
          // #407: pin the turn's live-data bindings on servable HTML only.
          ...(derivedBindings.length > 0 &&
          artifact.mimeType === "text/html"
            ? { dataBindings: derivedBindings }
            : {}),
          // #359: revision line-delta for the work receipt (+N −N).
          ...(() => {
            const priorContent = version.supersedesArtifactId
              ? priorContentById.get(version.supersedesArtifactId)
              : undefined;
            if (priorContent === undefined) return {};
            const delta = computeLineDelta(priorContent, artifact.content);
            return delta ? { lineDelta: delta } : {};
          })(),
        },
      })),
    )
    .onConflictDoNothing({
      target: [workspaceArtifacts.chatMessageId, workspaceArtifacts.filename],
    })
    .returning();

  // #456: artifact creation audits by construction — every lane (inline,
  // worker, and any future caller) creates artifacts through this one
  // function. References only; content stays in workspace_artifacts.
  if (rows.length > 0) {
    const auditNow = new Date();
    await db.insert(auditLog).values(
      rows.map((row) => ({
        actorUserId: userId,
        actionType: "workspace_artifact_create",
        status: "succeeded" as const,
        provider: "ai-hub",
        toolName: "workspace_artifact_create",
        chatThreadId: threadId,
        chatMessageId,
        runId: runId ?? null,
        input: {
          artifactId: row.id,
          filename: row.filename,
          versionNumber: row.versionNumber,
        },
        metadata: { kind: row.kind, mimeType: row.mimeType, sizeBytes: row.sizeBytes },
        startedAt: auditNow,
        completedAt: auditNow,
      })),
    );
  }

  return rows.map(serializeWorkspaceArtifact);
}

export async function loadWorkspaceArtifacts({
  db,
  userId,
  limit = 100,
}: {
  db: Database;
  userId: string;
  limit?: number;
}): Promise<WorkspaceArtifactSummary[]> {
  const rows = await db
    .select()
    .from(workspaceArtifacts)
    .where(eq(workspaceArtifacts.userId, userId))
    .orderBy(desc(workspaceArtifacts.createdAt))
    .limit(Math.max(1, Math.min(200, limit)));

  return rows.map(serializeWorkspaceArtifact);
}

export async function loadWorkspaceArtifactsForThread({
  db,
  userId,
  threadId,
  limit = 100,
}: {
  db: Database;
  userId: string;
  threadId: string;
  limit?: number;
}): Promise<WorkspaceArtifactSummary[]> {
  const rows = await db
    .select()
    .from(workspaceArtifacts)
    .where(
      and(
        eq(workspaceArtifacts.userId, userId),
        eq(workspaceArtifacts.threadId, threadId),
      ),
    )
    .orderBy(desc(workspaceArtifacts.createdAt))
    .limit(Math.max(1, Math.min(200, limit)));

  return rows.map(serializeWorkspaceArtifact);
}

export async function loadWorkspaceArtifactForUser({
  db,
  userId,
  artifactId,
}: {
  db: Database;
  userId: string;
  artifactId: string;
}): Promise<WorkspaceArtifact | null> {
  const rows = await db
    .select()
    .from(workspaceArtifacts)
    .where(
      and(
        eq(workspaceArtifacts.id, artifactId),
        eq(workspaceArtifacts.userId, userId),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function loadWorkspaceArtifactById({
  db,
  artifactId,
}: {
  db: Database;
  artifactId: string;
}): Promise<WorkspaceArtifact | null> {
  const rows = await db
    .select()
    .from(workspaceArtifacts)
    .where(eq(workspaceArtifacts.id, artifactId))
    .limit(1);

  return rows[0] ?? null;
}

export function serializeWorkspaceArtifact(
  artifact: WorkspaceArtifact,
): WorkspaceArtifactSummary {
  return {
    id: artifact.id,
    title: artifact.title,
    filename: artifact.filename,
    kind: artifact.kind,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    source: artifact.source,
    threadId: artifact.threadId,
    chatMessageId: artifact.chatMessageId,
    runId: artifact.runId,
    artifactGroupId: artifact.artifactGroupId,
    versionNumber: artifact.versionNumber,
    supersedesArtifactId: artifact.supersedesArtifactId,
    versionSummary: artifact.versionSummary,
    metadata: normalizeMetadata(artifact.metadata),
    createdAt: artifact.createdAt.toISOString(),
    previewUrl: `/workspace/artifacts/${artifact.id}`,
    downloadUrl: `/api/workspace/artifacts/${artifact.id}/download`,
  };
}

export function serializeWorkspaceArtifactDetail(
  artifact: WorkspaceArtifact,
): WorkspaceArtifactDetail {
  return {
    ...serializeWorkspaceArtifact(artifact),
    content: artifact.content,
  };
}

export function parseAssistantArtifacts(text: string): ParsedArtifact[] {
  const blocks = extractFencedCodeBlocks(text);
  const artifacts: ParsedArtifact[] = [];
  const usedFilenames = new Set<string>();

  for (const block of blocks) {
    if (artifacts.length >= MAX_ARTIFACTS_PER_MESSAGE) break;
    const content = block.content.trimEnd();
    if (!content || content.length > MAX_ARTIFACT_CHARS) continue;

    const explicitFilename = parseFilenameFromInfo(block.info);
    const language = normalizeLanguage(block.language);
    if (
      !shouldSaveArtifact({
        content,
        language,
        explicitFilename,
        closed: block.closed,
      })
    ) {
      continue;
    }

    const fallbackName = inferFilename({
      content,
      language,
      index: artifacts.length + 1,
    });
    const filename = uniqueFilename(
      sanitizeFilename(explicitFilename ?? fallbackName),
      usedFilenames,
    );
    usedFilenames.add(filename);

    const mimeType = mimeTypeForFilename(filename, language);
    artifacts.push({
      title: titleFromFilename(filename),
      filename,
      kind: kindForMimeType(mimeType, filename),
      mimeType,
      content,
      metadata: {
        language,
        explicitFilename: explicitFilename ?? null,
        extractedFrom: "assistant-markdown-code-fence",
        recoveredUnclosedFence: !block.closed,
      },
    });
  }

  if (artifacts.length === 0) {
    artifacts.push(...extractDeclaredTextArtifacts(text, usedFilenames));
  }

  return artifacts;
}

async function planArtifactVersions({
  db,
  userId,
  threadId,
  artifacts,
  targetArtifact,
  separateFromArtifact,
}: {
  db: Database;
  userId: string;
  threadId: string;
  artifacts: readonly ParsedArtifact[];
  targetArtifact?: WorkspaceArtifactVersionTarget | null;
  separateFromArtifact?: WorkspaceArtifactVersionTarget | null;
}): Promise<{
  planned: Array<{ artifact: ParsedArtifact; version: PlannedArtifactVersion }>;
  /** Prior content by artifact id, for revision line-delta counts (#359). */
  priorContentById: Map<string, string>;
}> {
  const scope =
    targetArtifact?.artifactGroupId
      ? or(
          eq(workspaceArtifacts.threadId, threadId),
          eq(workspaceArtifacts.artifactGroupId, targetArtifact.artifactGroupId),
        )
      : eq(workspaceArtifacts.threadId, threadId);
  const priorRows = await db
    .select()
    .from(workspaceArtifacts)
    .where(and(eq(workspaceArtifacts.userId, userId), scope))
    .orderBy(desc(workspaceArtifacts.versionNumber), desc(workspaceArtifacts.createdAt))
    .limit(200);

  return {
    planned: planArtifactVersionsForExistingArtifacts({
      artifacts,
      priorArtifacts: priorRows,
      targetArtifact,
      separateFromArtifact,
    }),
    priorContentById: new Map(priorRows.map((row) => [row.id, row.content])),
  };
}

function extractFencedCodeBlocks(text: string): FencedCodeBlock[] {
  const blocks: FencedCodeBlock[] = [];
  const fenceRe = /```([^\n`]*)\n([\s\S]*?)```/g;
  let lastClosedFenceEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(text)) !== null) {
    const info = (match[1] ?? "").trim();
    const language = info.split(/\s+/)[0] ?? "";
    blocks.push({
      info,
      language,
      content: match[2] ?? "",
      closed: true,
    });
    lastClosedFenceEnd = fenceRe.lastIndex;
  }

  const tail = text.slice(lastClosedFenceEnd);
  const unclosedFenceRe = /```([^\n`]*)\n/g;
  let unclosedMatch: RegExpExecArray | null = null;
  while (true) {
    const next = unclosedFenceRe.exec(tail);
    if (next === null) break;
    unclosedMatch = next;
  }

  if (unclosedMatch !== null) {
    const info = (unclosedMatch[1] ?? "").trim();
    const language = info.split(/\s+/)[0] ?? "";
    const content = tail.slice(unclosedMatch.index + unclosedMatch[0].length);
    blocks.push({
      info,
      language,
      content,
      closed: false,
    });
  }

  return blocks;
}

function parseFilenameFromInfo(info: string): string | undefined {
  const match =
    /(?:^|\s)(?:file(?:name)?=)?["']?([A-Za-z0-9._/ -]+\.[A-Za-z0-9]{1,12})["']?(?:\s|$)/.exec(
      info,
    );
  return match?.[1];
}

function extractDeclaredTextArtifacts(
  text: string,
  usedFilenames: Set<string>,
): ParsedArtifact[] {
  const artifacts: ParsedArtifact[] = [];
  const filenames = extractDeclaredTextFilenames(text);

  for (const declaredFilename of filenames) {
    if (artifacts.length >= MAX_ARTIFACTS_PER_MESSAGE) break;

    const filename = uniqueFilename(sanitizeFilename(declaredFilename), usedFilenames);
    if (!isRecoverableTextFilename(filename)) continue;

    const content = buildDeclaredTextArtifactContent(text, filename);
    if (
      !content ||
      content.length < MIN_DECLARED_TEXT_ARTIFACT_CHARS ||
      content.length > MAX_ARTIFACT_CHARS
    ) {
      continue;
    }

    usedFilenames.add(filename);
    const language = filename.endsWith(".txt") ? "text" : "markdown";
    const mimeType = mimeTypeForFilename(filename, language);
    artifacts.push({
      title: titleFromFilename(filename),
      filename,
      kind: kindForMimeType(mimeType, filename),
      mimeType,
      content,
      metadata: {
        language,
        explicitFilename: filename,
        extractedFrom: "assistant-declared-text-artifact",
      },
    });
  }

  return artifacts;
}

function extractDeclaredTextFilenames(text: string): string[] {
  const filenames: string[] = [];
  const seen = new Set<string>();
  const declarationRe =
    /\b(?:written|saved|created|generated)\s+(?:to|as)?\s*`?([A-Za-z0-9._/ -]+\.(?:md|markdown|txt))`?/gi;
  let match: RegExpExecArray | null;

  while ((match = declarationRe.exec(text)) !== null) {
    const filename = match[1]?.trim();
    if (!filename) continue;
    const normalized = filename.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    filenames.push(filename);
  }

  return filenames;
}

function isRecoverableTextFilename(filename: string): boolean {
  return /\.(?:md|markdown|txt)$/i.test(filename);
}

function buildDeclaredTextArtifactContent(
  assistantText: string,
  filename: string,
): string {
  let content = assistantText
    .replace(
      /\b(?:written|saved|created|generated)\s+(?:to|as)?\s*`?[A-Za-z0-9._/ -]+\.(?:md|markdown|txt)`?\.?/gi,
      "",
    )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!content) return "";
  if (/\.(?:md|markdown)$/i.test(filename) && !/^#\s+\S/m.test(content)) {
    content = `# ${titleFromFilename(filename)}\n\n${content}`;
  }
  return content;
}

function shouldSaveArtifact({
  content,
  language,
  explicitFilename,
  closed,
}: {
  content: string;
  language: string;
  explicitFilename?: string;
  closed: boolean;
}): boolean {
  if (!closed && !isLikelyCompleteUnclosedArtifact(content, language, explicitFilename)) {
    return false;
  }
  if (isHtmlArtifactCandidate(content, language, explicitFilename)) {
    return isCompleteHtmlDocument(content);
  }
  if (explicitFilename) return true;
  if (content.length < MIN_IMPLICIT_ARTIFACT_CHARS) return false;
  if (language === "markdown" || language === "md") {
    return /^#\s+\S/m.test(content);
  }
  if (language === "csv") return content.includes(",") && content.includes("\n");
  if (language === "json") return /^[\s\n]*[{[]/.test(content);
  return false;
}

function isHtmlArtifactCandidate(
  content: string,
  language: string,
  explicitFilename?: string,
): boolean {
  const normalizedLanguage = normalizeLanguage(language);
  const filename = explicitFilename?.toLowerCase() ?? "";
  return (
    normalizedLanguage === "html" ||
    filename.endsWith(".html") ||
    filename.endsWith(".htm") ||
    /<!doctype\s+html|<html[\s>]/i.test(content)
  );
}

function isCompleteHtmlDocument(content: string): boolean {
  const trimmed = content.trimEnd();
  return /<!doctype\s+html|<html[\s>]/i.test(trimmed) && /<\/html>\s*$/i.test(trimmed);
}

function isLikelyCompleteUnclosedArtifact(
  content: string,
  language: string,
  explicitFilename?: string,
): boolean {
  if (isHtmlArtifactCandidate(content, language, explicitFilename)) {
    return /<\/body>\s*<\/html>\s*$/i.test(content.trimEnd());
  }

  const normalizedLanguage = normalizeLanguage(language);
  const filename = explicitFilename?.toLowerCase() ?? "";

  if (normalizedLanguage === "json" || filename.endsWith(".json")) {
    try {
      JSON.parse(content);
      return true;
    } catch {
      return false;
    }
  }

  if (
    normalizedLanguage === "markdown" ||
    filename.endsWith(".md") ||
    filename.endsWith(".markdown") ||
    filename.endsWith(".txt")
  ) {
    return content.trim().length >= MIN_DECLARED_TEXT_ARTIFACT_CHARS;
  }

  return false;
}

function inferFilename({
  content,
  language,
  index,
}: {
  content: string;
  language: string;
  index: number;
}): string {
  const title = titleFromContent(content) ?? `artifact-${index}`;
  const ext = extensionForLanguage(language, content);
  return `${slugify(title)}.${ext}`;
}

function titleFromContent(content: string): string | undefined {
  const htmlTitle = /<title[^>]*>([^<]+)<\/title>/i.exec(content)?.[1];
  if (htmlTitle) return htmlTitle;
  const heading = /^#\s+(.+)$/m.exec(content)?.[1];
  if (heading) return heading;
  return undefined;
}

function extensionForLanguage(language: string, content: string): string {
  if (language === "html" || /<!doctype\s+html|<html[\s>]/i.test(content)) {
    return "html";
  }
  if (language === "markdown") return "md";
  if (language === "javascript") return "js";
  if (language === "typescript") return "ts";
  return (
    {
      md: "md",
      json: "json",
      csv: "csv",
      css: "css",
      js: "js",
      jsx: "jsx",
      ts: "ts",
      tsx: "tsx",
      py: "py",
      txt: "txt",
    } as Record<string, string>
  )[language] ?? "txt";
}

function mimeTypeForFilename(filename: string, language: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  return (
    {
      html: "text/html",
      htm: "text/html",
      md: "text/markdown",
      markdown: "text/markdown",
      txt: "text/plain",
      csv: "text/csv",
      json: "application/json",
      css: "text/css",
      js: "text/javascript",
      jsx: "text/javascript",
      ts: "text/typescript",
      tsx: "text/typescript",
      py: "text/x-python",
    } as Record<string, string>
  )[ext ?? ""] ?? (language === "json" ? "application/json" : "text/plain");
}

function kindForMimeType(mimeType: string, filename: string): string {
  if (mimeType === "text/html") return "html";
  if (mimeType === "text/markdown") return "markdown";
  if (mimeType === "application/json") return "data";
  if (filename.endsWith(".csv")) return "data";
  return "file";
}

function normalizeLanguage(language: string): string {
  const value = language.trim().toLowerCase();
  if (value === "md") return "markdown";
  if (value === "javascript") return "js";
  if (value === "typescript") return "ts";
  return value;
}

function uniqueFilename(filename: string, used: Set<string>): string {
  if (!used.has(filename)) return filename;
  const dot = filename.lastIndexOf(".");
  const stem = dot === -1 ? filename : filename.slice(0, dot);
  const ext = dot === -1 ? "" : filename.slice(dot);
  for (let i = 2; i < 100; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

function titleFromFilename(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "");
  return stem
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "artifact";
}

function normalizeMetadata(value: unknown): Record<string, unknown> | null {
  // Every serialized artifact flows to clients through here, so strip the raw
  // query out of any #407 data bindings — viewers invoke bindings by id and
  // must never receive the author's pinned query text.
  return scrubBindingsForClient(isRecord(value) ? value : null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
