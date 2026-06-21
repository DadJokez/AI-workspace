import {
  type Database,
  workspaceArtifacts,
  type WorkspaceArtifact,
} from "@ai-workspace/db";
import { and, desc, eq, or } from "drizzle-orm";
import { randomUUID } from "crypto";

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
}

export interface ParsedArtifact {
  title: string;
  filename: string;
  kind: string;
  mimeType: string;
  content: string;
  metadata: Record<string, unknown>;
}

export interface PlannedArtifactVersion {
  artifactKey: string;
  artifactGroupId: string;
  versionNumber: number;
  supersedesArtifactId: string | null;
  filename: string;
  title?: string;
  versionSummary: string;
}

export interface WorkspaceArtifactVersionTarget {
  id: string;
  title: string;
  filename: string;
  artifactGroupId: string;
  versionNumber: number;
  metadata: Record<string, unknown> | null;
}

type ArtifactVersionPrior = Pick<
  WorkspaceArtifact,
  "id" | "title" | "artifactGroupId" | "versionNumber" | "filename" | "metadata"
>;

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
}: CreateArtifactsInput): Promise<WorkspaceArtifactSummary[]> {
  const parsed = parseAssistantArtifacts(assistantText);
  if (parsed.length === 0) return [];
  const planned = await planArtifactVersions({
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
        },
      })),
    )
    .onConflictDoNothing({
      target: [workspaceArtifacts.chatMessageId, workspaceArtifacts.filename],
    })
    .returning();

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

export function toWorkspaceArtifactVersionTarget(
  artifact: WorkspaceArtifactSummary,
): WorkspaceArtifactVersionTarget {
  return {
    id: artifact.id,
    title: artifact.title,
    filename: artifact.filename,
    artifactGroupId: artifact.artifactGroupId,
    versionNumber: artifact.versionNumber,
    metadata: artifact.metadata ?? null,
  };
}

export function parseWorkspaceArtifactVersionTarget(
  value: unknown,
): WorkspaceArtifactVersionTarget | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.filename !== "string" ||
    typeof value.artifactGroupId !== "string" ||
    typeof value.versionNumber !== "number"
  ) {
    return null;
  }
  return {
    id: value.id,
    title: value.title,
    filename: value.filename,
    artifactGroupId: value.artifactGroupId,
    versionNumber: value.versionNumber,
    metadata: isRecord(value.metadata) ? value.metadata : null,
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
}): Promise<
  Array<{ artifact: ParsedArtifact; version: PlannedArtifactVersion }>
> {
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

  return planArtifactVersionsForExistingArtifacts({
    artifacts,
    priorArtifacts: priorRows,
    targetArtifact,
    separateFromArtifact,
  });
}

export function planArtifactVersionsForExistingArtifacts({
  artifacts,
  priorArtifacts,
  targetArtifact,
  separateFromArtifact,
}: {
  artifacts: readonly ParsedArtifact[];
  priorArtifacts: readonly ArtifactVersionPrior[];
  targetArtifact?: WorkspaceArtifactVersionTarget | null;
  separateFromArtifact?: WorkspaceArtifactVersionTarget | null;
}): Array<{ artifact: ParsedArtifact; version: PlannedArtifactVersion }> {
  const targetKey = targetArtifact
    ? artifactKeyFromArtifact(targetArtifact)
    : null;
  const latestByKey = new Map<
    string,
    Pick<
      WorkspaceArtifact,
      | "id"
      | "title"
      | "artifactGroupId"
      | "versionNumber"
      | "filename"
      | "metadata"
    >
  >();
  const latestTargetByKey = new Map<string, ArtifactVersionPrior>();

  for (const row of priorArtifacts) {
    const key = artifactKeyFromArtifact(row);
    if (row.artifactGroupId === targetArtifact?.artifactGroupId) {
      if (!latestTargetByKey.has(key)) latestTargetByKey.set(key, row);
      continue;
    }
    if (!latestByKey.has(key)) latestByKey.set(key, row);
  }

  if (targetArtifact && targetKey && !latestTargetByKey.has(targetKey)) {
    latestTargetByKey.set(targetKey, targetArtifact);
  }

  for (const [key, row] of latestTargetByKey) {
    latestByKey.set(key, row);
  }

  const planned: Array<{
    artifact: ParsedArtifact;
    version: PlannedArtifactVersion;
  }> = [];

  for (const [index, artifact] of artifacts.entries()) {
    const parsedArtifactKey = artifactKeyFromFilename(artifact.filename);
    const separateFromKey = separateFromArtifact
      ? artifactKeyFromArtifact(separateFromArtifact)
      : null;
    const separateFilename =
      separateFromArtifact &&
      separateFromKey &&
      isCompatibleArtifactRevision(artifact.filename, separateFromArtifact.filename) &&
      (parsedArtifactKey === separateFromKey ||
        (artifacts.length === 1 && isGenericRevisionFilename(artifact.filename)))
        ? filenameForSeparateCopy({
            emittedFilename: artifact.filename,
            sourceArtifact: separateFromArtifact,
            existingKeys: latestByKey,
          })
        : null;
    const useTarget =
      !separateFilename &&
      !!targetArtifact &&
      !!targetKey &&
      (parsedArtifactKey === targetKey ||
        (artifacts.length === 1 &&
          isCompatibleArtifactRevision(artifact.filename, targetArtifact.filename) &&
          !latestByKey.has(parsedArtifactKey)));
    const artifactKey = separateFilename
      ? artifactKeyFromVisibleFilename(separateFilename)
      : useTarget
        ? targetKey
        : parsedArtifactKey;
    const prior = separateFilename ? undefined : latestByKey.get(artifactKey);
    const versionNumber = prior ? prior.versionNumber + 1 : 1;
    const artifactGroupId = prior?.artifactGroupId ?? randomUUID();
    const existingArtifact = useTarget ? targetArtifact : prior;
    const filename =
      separateFilename ??
      (existingArtifact
        ? canonicalFilenameForArtifact(existingArtifact)
        : sanitizeFilename(artifact.filename));
    const version: PlannedArtifactVersion = {
      artifactKey,
      artifactGroupId,
      versionNumber,
      supersedesArtifactId: prior?.id ?? null,
      filename,
      ...(useTarget ? { title: targetArtifact.title } : {}),
      versionSummary:
        versionNumber === 1
          ? "Initial artifact created from chat."
          : `Version ${versionNumber} created from chat revision.`,
    };
    planned.push({ artifact, version });
    latestByKey.set(artifactKey, {
      id: `planned:${index + 1}`,
      title: version.title ?? artifact.title,
      artifactGroupId,
      versionNumber,
      filename,
      metadata: { artifactKey },
    });
  }

  return planned;
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
  if (explicitFilename) return true;
  if (content.length < MIN_IMPLICIT_ARTIFACT_CHARS) return false;
  if (/<!doctype\s+html|<html[\s>]/i.test(content)) return true;
  if (language === "markdown" || language === "md") {
    return /^#\s+\S/m.test(content);
  }
  if (language === "csv") return content.includes(",") && content.includes("\n");
  if (language === "json") return /^[\s\n]*[{[]/.test(content);
  return false;
}

function isLikelyCompleteUnclosedArtifact(
  content: string,
  language: string,
  explicitFilename?: string,
): boolean {
  const normalizedLanguage = normalizeLanguage(language);
  const filename = explicitFilename?.toLowerCase() ?? "";

  if (
    normalizedLanguage === "html" ||
    filename.endsWith(".html") ||
    filename.endsWith(".htm") ||
    /<!doctype\s+html|<html[\s>]/i.test(content)
  ) {
    return /<\/body>\s*<\/html>\s*$/i.test(content.trimEnd());
  }

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

function sanitizeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).filter(Boolean).pop() ?? "artifact.txt";
  const clean = base
    .replace(/[^A-Za-z0-9._ -]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return clean.includes(".") ? clean : `${clean || "artifact"}.txt`;
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
  return isRecord(value) ? value : null;
}

function artifactKeyFromArtifact(
  artifact: Pick<WorkspaceArtifact, "filename" | "metadata">,
): string {
  const metadata = normalizeMetadata(artifact.metadata);
  return typeof metadata?.artifactKey === "string"
    ? metadata.artifactKey
    : artifactKeyFromFilename(artifact.filename);
}

function artifactKeyFromFilename(filename: string): string {
  const clean = sanitizeFilename(filename).toLowerCase();
  const dot = clean.lastIndexOf(".");
  const stem = dot === -1 ? clean : clean.slice(0, dot);
  const ext = dot === -1 ? "" : clean.slice(dot + 1);
  const base = stem
    .replace(/(?:^|[-_. ])v(?:ersion)?[-_. ]?\d+$/i, "")
    .replace(/[-_. ]+\d+$/i, "")
    .replace(/[-_. ]+$/, "");
  return `${base || "artifact"}.${ext || "txt"}`;
}

function artifactKeyFromVisibleFilename(filename: string): string {
  const clean = sanitizeFilename(filename).toLowerCase();
  const dot = clean.lastIndexOf(".");
  const ext = dot === -1 ? "txt" : clean.slice(dot + 1);
  return clean.includes(".") ? clean : `${clean}.${ext}`;
}

function filenameForSeparateCopy({
  emittedFilename,
  sourceArtifact,
  existingKeys,
}: {
  emittedFilename: string;
  sourceArtifact: Pick<WorkspaceArtifact, "filename" | "metadata">;
  existingKeys: ReadonlyMap<string, unknown>;
}): string {
  const emitted = sanitizeFilename(emittedFilename);
  const source = canonicalFilenameForArtifact(sourceArtifact);
  const emittedKey = artifactKeyFromVisibleFilename(emitted);
  const sourceKey = artifactKeyFromVisibleFilename(source);
  if (
    emittedKey !== sourceKey &&
    !isGenericRevisionFilename(emitted) &&
    !existingKeys.has(emittedKey)
  ) {
    return emitted;
  }

  const dot = source.lastIndexOf(".");
  const stem = dot === -1 ? source : source.slice(0, dot);
  const ext = dot === -1 ? "" : source.slice(dot);
  for (let i = 1; i < 100; i++) {
    const suffix = i === 1 ? "copy" : `copy-${i}`;
    const candidate = `${stem}-${suffix}${ext}`;
    if (!existingKeys.has(artifactKeyFromVisibleFilename(candidate))) {
      return candidate;
    }
  }
  return `${stem}-copy-${Date.now()}${ext}`;
}

function isGenericRevisionFilename(filename: string): boolean {
  const clean = sanitizeFilename(filename).toLowerCase();
  const dot = clean.lastIndexOf(".");
  const stem = dot === -1 ? clean : clean.slice(0, dot);
  return /^(?:updated|revised|revision|artifact|file|document|output|result)(?:[-_ ]?\d+)?$/.test(
    stem,
  );
}

function canonicalFilenameForArtifact(
  artifact: Pick<WorkspaceArtifact, "filename" | "metadata">,
): string {
  const metadata = normalizeMetadata(artifact.metadata);
  const artifactKey =
    typeof metadata?.artifactKey === "string"
      ? sanitizeFilename(metadata.artifactKey)
      : null;
  if (artifactKey && normalizedExtension(artifactKey) === normalizedExtension(artifact.filename)) {
    return artifactKey;
  }
  return filenameWithoutVisibleVersionSuffix(artifact.filename);
}

function filenameWithoutVisibleVersionSuffix(filename: string): string {
  const clean = sanitizeFilename(filename);
  const dot = clean.lastIndexOf(".");
  const stem = dot === -1 ? clean : clean.slice(0, dot);
  const ext = dot === -1 ? "" : clean.slice(dot);
  const base = stem
    .replace(/(?:^|[-_. ])v(?:ersion)?[-_. ]?\d+$/i, "")
    .replace(/[-_. ]+$/, "");
  return `${base || "artifact"}${ext}`;
}

function isCompatibleArtifactRevision(
  emittedFilename: string,
  targetFilename: string,
): boolean {
  return normalizedExtension(emittedFilename) === normalizedExtension(targetFilename);
}

function normalizedExtension(filename: string): string {
  const ext = sanitizeFilename(filename).split(".").pop()?.toLowerCase() ?? "txt";
  if (ext === "htm") return "html";
  if (ext === "markdown") return "md";
  return ext;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
