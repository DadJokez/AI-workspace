export type AssistantSourceKind = "web" | "repo" | "file" | "artifact";

export interface AssistantSource {
  n: number;
  title: string;
  url?: string;
  kind: AssistantSourceKind;
  toolCallId?: string;
}

interface SourceToolCall {
  id: string;
  name?: string;
  provider?: string | null;
  toolName?: string;
  input?: Record<string, unknown>;
}

interface SourceToolResult {
  toolCallId: string;
  name?: string;
  provider?: string | null;
  toolName?: string;
  output: unknown;
  isError?: boolean;
}

interface GitHubContext {
  toolCallId: string;
  toolName: string;
  owner?: string;
  repo?: string;
  ref?: string;
}

interface SourceCandidate {
  title: string;
  url: string;
  kind: AssistantSourceKind;
  toolCallId: string;
}

const MAX_SOURCES = 20;
const MAX_WALK_DEPTH = 7;
const MAX_TITLE_LENGTH = 180;
const GITHUB_URL_RE =
  /https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\/[^\s)\]}>"']*)?/gi;

export function extractAssistantSources({
  toolCalls = [],
  toolResults = [],
}: {
  toolCalls?: readonly SourceToolCall[];
  toolResults?: readonly SourceToolResult[];
}): AssistantSource[] {
  const callsById = new Map(toolCalls.map((call) => [call.id, call]));
  const candidates: SourceCandidate[] = [];

  for (const result of toolResults) {
    if (result.isError) continue;
    const call = callsById.get(result.toolCallId);
    const provider =
      result.provider ??
      call?.provider ??
      providerFromName(result.name ?? call?.name);
    if (provider?.toLowerCase() !== "github") continue;

    const input = call?.input ?? {};
    const context: GitHubContext = {
      toolCallId: result.toolCallId,
      toolName:
        result.toolName ?? call?.toolName ?? result.name ?? call?.name ?? "",
      owner: stringValue(input.owner),
      repo: stringValue(input.repo),
      ref:
        stringValue(input.ref) ??
        stringValue(input.branch) ??
        stringValue(input.sha),
    };
    collectGitHubSources(result.output, context, candidates, 0, new Set());
  }

  const seen = new Set<string>();
  return candidates
    .filter((candidate) => {
      if (seen.has(candidate.url)) return false;
      seen.add(candidate.url);
      return true;
    })
    .slice(0, MAX_SOURCES)
    .map((candidate, index) => ({
      n: index + 1,
      title: candidate.title,
      url: candidate.url,
      kind: candidate.kind,
      toolCallId: candidate.toolCallId,
    }));
}

export function parseAssistantSources(value: unknown): AssistantSource[] {
  if (!Array.isArray(value)) return [];
  const parsed: AssistantSource[] = [];
  const seenNumbers = new Set<number>();

  for (const item of value) {
    if (!isRecord(item)) continue;
    const n = item.n;
    const title = normalizeTitle(item.title);
    const kind = item.kind;
    if (
      !Number.isInteger(n) ||
      (n as number) < 1 ||
      seenNumbers.has(n as number) ||
      !title ||
      !isSourceKind(kind)
    ) {
      continue;
    }
    const url = safeSourceUrl(item.url);
    const toolCallId = normalizeTitle(item.toolCallId);
    seenNumbers.add(n as number);
    parsed.push({
      n: n as number,
      title,
      kind,
      ...(url ? { url } : {}),
      ...(toolCallId ? { toolCallId } : {}),
    });
  }

  return parsed.sort((left, right) => left.n - right.n).slice(0, MAX_SOURCES);
}

function collectGitHubSources(
  value: unknown,
  context: GitHubContext,
  candidates: SourceCandidate[],
  depth: number,
  seen: Set<object>,
): void {
  if (depth > MAX_WALK_DEPTH || candidates.length >= MAX_SOURCES * 2) return;

  if (typeof value === "string") {
    const parsed = parseJson(value);
    if (parsed !== undefined) {
      collectGitHubSources(parsed, context, candidates, depth + 1, seen);
      return;
    }
    for (const match of value.matchAll(GITHUB_URL_RE)) {
      const url = safeGitHubWebUrl(match[0].replace(/[.,;:!?]+$/, ""));
      if (url) addCandidate(candidates, context, url, titleFromUrl(url));
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectGitHubSources(item, context, candidates, depth + 1, seen);
    }
    return;
  }
  if (!isRecord(value) || seen.has(value)) return;
  seen.add(value);

  const directUrl = githubUrlFromRecord(value, context);
  if (directUrl) {
    addCandidate(
      candidates,
      context,
      directUrl,
      titleFromRecord(value, directUrl),
    );
  } else {
    const path = stringValue(value.path) ?? stringValue(value.filename);
    const fileUrl = path ? githubFileUrl(path, context) : undefined;
    if (path && fileUrl) {
      addCandidate(candidates, context, fileUrl, normalizeTitle(path) ?? path);
    }
  }

  for (const [key, nested] of Object.entries(value)) {
    if (key === "patch" || key === "diff") continue;
    if (key === "content" && typeof nested === "string" && !looksLikeJson(nested)) {
      continue;
    }
    if (typeof nested === "object" && nested !== null) {
      collectGitHubSources(nested, context, candidates, depth + 1, seen);
    } else if (
      typeof nested === "string" &&
      (looksLikeJson(nested) || nested.includes("https://github.com/"))
    ) {
      collectGitHubSources(nested, context, candidates, depth + 1, seen);
    }
  }
}

function addCandidate(
  candidates: SourceCandidate[],
  context: GitHubContext,
  url: string,
  title: string,
): void {
  const normalizedTitle = normalizeTitle(title) ?? titleFromUrl(url);
  candidates.push({
    title: normalizedTitle,
    url,
    kind: "repo",
    toolCallId: context.toolCallId,
  });
}

function githubUrlFromRecord(
  value: Record<string, unknown>,
  context: GitHubContext,
): string | undefined {
  for (const key of ["html_url", "htmlUrl", "web_url", "webUrl", "url"]) {
    const raw = stringValue(value[key]);
    if (!raw) continue;
    const direct = safeGitHubWebUrl(raw);
    if (direct) return direct;
    const converted = githubApiUrlToWebUrl(raw, context);
    if (converted) return converted;
  }
  return undefined;
}

function githubApiUrlToWebUrl(
  raw: string,
  context: GitHubContext,
): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "api.github.com") {
    return undefined;
  }
  const match = /^\/repos\/([^/]+)\/([^/]+)\/(pulls|issues|contents)\/(.+)$/.exec(
    parsed.pathname,
  );
  if (!match) return undefined;
  const owner = match[1]!;
  const repo = match[2]!;
  const kind = match[3]!;
  const rest = match[4]!;
  if (kind === "pulls") return `https://github.com/${owner}/${repo}/pull/${rest}`;
  if (kind === "issues") return `https://github.com/${owner}/${repo}/issues/${rest}`;
  return githubFileUrl(decodeURIComponent(rest), {
    ...context,
    owner,
    repo,
    ref: parsed.searchParams.get("ref") ?? context.ref,
  });
}

function githubFileUrl(
  path: string,
  context: GitHubContext,
): string | undefined {
  if (!context.owner || !context.repo || !isFileTool(context.toolName)) {
    return undefined;
  }
  const safePath = path
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  if (!safePath) return undefined;
  const ref = encodeURIComponent(context.ref ?? "HEAD");
  return `https://github.com/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repo)}/blob/${ref}/${safePath}`;
}

function titleFromRecord(
  value: Record<string, unknown>,
  url: string,
): string {
  const title =
    normalizeTitle(value.title) ??
    normalizeTitle(value.name) ??
    normalizeTitle(value.path) ??
    normalizeTitle(value.filename);
  if (title) return title;
  return titleFromUrl(url);
}

function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname).replace(/^\//, "");
    return path || parsed.hostname;
  } catch {
    return "GitHub source";
  }
}

function safeGitHubWebUrl(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== "https:" ||
    !["github.com", "www.github.com"].includes(parsed.hostname.toLowerCase())
  ) {
    return undefined;
  }
  parsed.hostname = "github.com";
  parsed.hash = "";
  return parsed.toString();
}

function safeSourceUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_000) return undefined;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function providerFromName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const match = /^(?:mcp__)?([^_.]+)(?:__|[._])/.exec(name);
  return match?.[1];
}

function isFileTool(toolName: string): boolean {
  return /(file|content|blob)/i.test(toolName);
}

function isSourceKind(value: unknown): value is AssistantSourceKind {
  return (
    value === "web" ||
    value === "repo" ||
    value === "file" ||
    value === "artifact"
  );
}

function normalizeTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  })
    .join("")
    .trim();
  return normalized ? normalized.slice(0, MAX_TITLE_LENGTH) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseJson(value: string): unknown | undefined {
  if (!looksLikeJson(value)) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
