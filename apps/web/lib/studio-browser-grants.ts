import { timingSafeEqual } from "node:crypto";
import {
  appVersions,
  apps,
  auditLog,
  type Database,
  studioBrowserGrants,
  studioBrowserSessions,
  studioSandboxEndpoints,
  workspaceArtifacts,
} from "@ai-workspace/db";
import { and, eq } from "drizzle-orm";
import { hashGrantToken, StudioBrowserError } from "@/lib/studio-browser";

const GRANT_COOKIE_PREFIX = "cmp_studio_browser_";
const MAX_SANDBOX_RESPONSE_BYTES = 5 * 1024 * 1024;
const SANDBOX_TIMEOUT_MS = 8_000;

const PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'self'",
  "style-src 'unsafe-inline' 'self'",
  "img-src data: blob: 'self'",
  "font-src data: 'self'",
  "media-src data: blob: 'self'",
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

export interface StudioBrowserGrantContext {
  grant: typeof studioBrowserGrants.$inferSelect;
  session: typeof studioBrowserSessions.$inferSelect;
}

export interface StudioBrowserGrantPayload {
  body: BodyInit | null;
  status: number;
  headers: Headers;
}

export async function authorizeStudioBrowserGrant({
  db,
  grantId,
  token,
  now = new Date(),
}: {
  db: Database;
  grantId: string;
  token: string;
  now?: Date;
}): Promise<StudioBrowserGrantContext> {
  if (!isBearerToken(token)) throw invalidGrant();
  const context = await loadGrantContext(db, grantId);
  assertGrantActive(context, now);
  const suppliedHash = Buffer.from(hashGrantToken(token), "hex");
  const expectedHash = Buffer.from(context.grant.tokenHash, "hex");
  if (
    suppliedHash.length !== expectedHash.length ||
    !timingSafeEqual(suppliedHash, expectedHash)
  ) {
    throw invalidGrant();
  }
  return context;
}

export async function requireStudioBrowserGrant({
  db,
  grantId,
  cookieToken,
  now = new Date(),
}: {
  db: Database;
  grantId: string;
  cookieToken?: string;
  now?: Date;
}): Promise<StudioBrowserGrantContext> {
  if (!cookieToken) throw invalidGrant();
  return authorizeStudioBrowserGrant({ db, grantId, token: cookieToken, now });
}

export function studioBrowserGrantCookieName(grantId: string): string {
  return `${GRANT_COOKIE_PREFIX}${grantId.replaceAll("-", "")}`;
}

export function studioBrowserGrantBootstrap(grantId: string): string {
  const authorizePath = JSON.stringify(
    `/api/studio/browser/grants/${encodeURIComponent(grantId)}/authorize`,
  );
  const contentPath = JSON.stringify(
    `/api/studio/browser/grants/${encodeURIComponent(grantId)}`,
  );
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Opening Comparative Browser</title></head>
<body><p id="status">Opening authorized preview...</p>
<script>
(async function () {
  const status = document.getElementById("status");
  const token = new URLSearchParams(location.hash.slice(1)).get("grant");
  history.replaceState(null, "", location.pathname);
  if (!token) { status.textContent = "This preview grant is unavailable."; return; }
  try {
    const response = await fetch(${authorizePath}, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant: token })
    });
    if (!response.ok) throw new Error("authorize");
    location.replace(${contentPath});
  } catch {
    status.textContent = "This preview grant expired or is unavailable.";
  }
})();
</script></body></html>`;
}

export function studioBrowserBootstrapHeaders(): HeadersInit {
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": [
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "connect-src 'self'",
      "style-src 'none'",
      "img-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ].join("; "),
    "cache-control": "private, no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

export async function loadStudioBrowserGrantPayload({
  db,
  context,
  pathSegments,
  search,
  method,
  fetchImpl = fetch,
  now = new Date(),
}: {
  db: Database;
  context: StudioBrowserGrantContext;
  pathSegments: string[];
  search: string;
  method: "GET" | "HEAD";
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<StudioBrowserGrantPayload> {
  assertGrantActive(context, now);
  const path = normalizeGrantPath(pathSegments);
  const { grant } = context;

  if (grant.targetKind === "artifact") {
    if (path !== "/") throw targetMissing();
    const rows = await db
      .select()
      .from(workspaceArtifacts)
      .where(
        and(
          eq(workspaceArtifacts.id, grant.targetResourceId),
          eq(workspaceArtifacts.userId, grant.userId),
          eq(workspaceArtifacts.threadId, grant.threadId),
        ),
      )
      .limit(1);
    const artifact = rows[0];
    if (!artifact) throw targetMissing();
    await auditGrantAccess(db, context, "artifact", artifact.id, path);
    return contentPayload({
      content: artifact.content,
      mimeType: artifact.mimeType,
      method,
      grantId: grant.id,
      path,
    });
  }

  if (grant.targetKind === "app") {
    if (path !== "/") throw targetMissing();
    const rows = await db
      .select({ artifact: workspaceArtifacts, appId: apps.id })
      .from(appVersions)
      .innerJoin(apps, eq(apps.id, appVersions.appId))
      .innerJoin(
        workspaceArtifacts,
        eq(workspaceArtifacts.id, appVersions.artifactId),
      )
      .where(
        and(
          eq(appVersions.id, grant.targetResourceId),
          eq(apps.ownerUserId, grant.userId),
          eq(workspaceArtifacts.userId, grant.userId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw targetMissing();
    await auditGrantAccess(db, context, "app", row.appId, path);
    return contentPayload({
      content: row.artifact.content,
      mimeType: "text/html",
      method,
      grantId: grant.id,
      path,
    });
  }

  if (grant.targetKind !== "sandbox" || !grant.sandboxPort) {
    throw targetMissing();
  }
  const endpointRows = await db
    .select()
    .from(studioSandboxEndpoints)
    .where(
      and(
        eq(studioSandboxEndpoints.id, grant.targetResourceId),
        eq(studioSandboxEndpoints.userId, grant.userId),
        eq(studioSandboxEndpoints.threadId, grant.threadId),
        eq(studioSandboxEndpoints.status, "active"),
      ),
    )
    .limit(1);
  const endpoint = endpointRows[0];
  const allowedPorts = Array.isArray(endpoint?.allowedPorts)
    ? endpoint.allowedPorts
    : [];
  if (
    !endpoint ||
    endpoint.expiresAt <= now ||
    endpoint.runId !== grant.runId ||
    !allowedPorts.includes(grant.sandboxPort) ||
    !isTrustedSandboxHostname(endpoint.hostname)
  ) {
    throw targetMissing();
  }

  const upstreamUrl = new URL(
    `${path}${safeSearch(search)}`,
    `http://${endpoint.hostname}:${grant.sandboxPort}`,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SANDBOX_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(upstreamUrl, {
      method,
      redirect: "manual",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml,application/json,text/plain,*/*",
        "user-agent": "Comparative-Studio-Browser/1.0",
      },
    });
  } catch {
    throw new StudioBrowserError(
      "browser_sandbox_unavailable",
      "The task sandbox is no longer available.",
      502,
    );
  } finally {
    clearTimeout(timeout);
  }

  const location = response.headers.get("location");
  if (location && response.status >= 300 && response.status < 400) {
    const rewritten = rewriteSandboxRedirect({
      location,
      upstreamUrl,
      expectedHostname: endpoint.hostname,
      expectedPort: grant.sandboxPort,
      grantId: grant.id,
    });
    return {
      body: null,
      status: response.status,
      headers: new Headers({
        location: rewritten,
        "cache-control": "private, no-store",
      }),
    };
  }

  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > MAX_SANDBOX_RESPONSE_BYTES) throw responseTooLarge();
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_SANDBOX_RESPONSE_BYTES) throw responseTooLarge();
  const contentType = safeContentType(response.headers.get("content-type"));
  const body =
    contentType.startsWith("text/html")
      ? new TextEncoder().encode(
          injectGrantBase(
            new TextDecoder().decode(bytes),
            grant.id,
            path,
          ),
        )
      : bytes;
  if (path === "/") {
    await auditGrantAccess(db, context, "sandbox", endpoint.id, path);
  }
  return {
    body: method === "HEAD" ? null : body,
    status: response.status,
    headers: responseHeaders(contentType),
  };
}

export function normalizeGrantPath(pathSegments: string[]): string {
  if (pathSegments.length === 0) return "/";
  const safe = pathSegments.map((segment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw targetMissing();
    }
    if (
      !decoded ||
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(decoded)
    ) {
      throw targetMissing();
    }
    return encodeURIComponent(decoded);
  });
  return `/${safe.join("/")}`;
}

export function isTrustedSandboxHostname(hostname: string): boolean {
  const suffix = (
    process.env.STUDIO_SANDBOX_DNS_SUFFIX ?? ".comparative.internal"
  ).toLowerCase();
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  return (
    suffix.startsWith(".") &&
    normalized.endsWith(suffix) &&
    normalized.length > suffix.length &&
    /^[a-z0-9.-]+$/.test(normalized) &&
    !normalized.includes("..")
  );
}

export function rewriteSandboxRedirect({
  location,
  upstreamUrl,
  expectedHostname,
  expectedPort,
  grantId,
}: {
  location: string;
  upstreamUrl: URL;
  expectedHostname: string;
  expectedPort: number;
  grantId: string;
}): string {
  let target: URL;
  try {
    target = new URL(location, upstreamUrl);
  } catch {
    throw new StudioBrowserError(
      "browser_sandbox_redirect_blocked",
      "The task sandbox returned an invalid redirect.",
      502,
    );
  }
  if (
    target.protocol !== "http:" ||
    target.hostname.toLowerCase() !== expectedHostname.toLowerCase() ||
    Number(target.port || "80") !== expectedPort
  ) {
    throw new StudioBrowserError(
      "browser_sandbox_redirect_blocked",
      "The task sandbox attempted to leave its authorized origin.",
      502,
    );
  }
  let segments: string[];
  try {
    segments = target.pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    throw new StudioBrowserError(
      "browser_sandbox_redirect_blocked",
      "The task sandbox returned an invalid redirect.",
      502,
    );
  }
  const path = normalizeGrantPath(segments);
  return `/api/studio/browser/grants/${encodeURIComponent(grantId)}${
    path === "/" ? "" : path
  }${safeSearch(target.search)}`;
}

function contentPayload({
  content,
  mimeType,
  method,
  grantId,
  path,
}: {
  content: string;
  mimeType: string;
  method: "GET" | "HEAD";
  grantId: string;
  path: string;
}): StudioBrowserGrantPayload {
  const safeMime = safeContentType(mimeType);
  const body = safeMime.startsWith("text/html")
    ? injectGrantBase(content, grantId, path)
    : content;
  return {
    body: method === "HEAD" ? null : body,
    status: 200,
    headers: responseHeaders(safeMime),
  };
}

function injectGrantBase(html: string, grantId: string, path: string): string {
  const directory = path.endsWith("/")
    ? path
    : path.slice(0, Math.max(0, path.lastIndexOf("/") + 1));
  const base = `/api/studio/browser/grants/${encodeURIComponent(grantId)}${directory}`;
  const tag = `<base href="${escapeAttribute(base)}">`;
  if (/<head(?:\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${tag}`);
  }
  return `${tag}${html}`;
}

function responseHeaders(contentType: string): Headers {
  return new Headers({
    "content-type": contentType,
    "content-security-policy": PREVIEW_CSP,
    "cache-control": "private, no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
  });
}

function safeContentType(value: string | null): string {
  const normalized = (value ?? "application/octet-stream")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  if (
    normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized === "application/javascript" ||
    normalized === "application/xml" ||
    normalized === "image/png" ||
    normalized === "image/jpeg" ||
    normalized === "image/gif" ||
    normalized === "image/webp" ||
    normalized === "image/svg+xml" ||
    normalized === "font/woff" ||
    normalized === "font/woff2"
  ) {
    return `${normalized}${
      normalized.startsWith("text/") ||
      normalized === "application/json" ||
      normalized === "application/javascript" ||
      normalized === "application/xml"
        ? "; charset=utf-8"
        : ""
    }`;
  }
  return "application/octet-stream";
}

function safeSearch(search: string): string {
  if (!search) return "";
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  params.delete("grant");
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

async function loadGrantContext(
  db: Database,
  grantId: string,
): Promise<StudioBrowserGrantContext> {
  const rows = await db
    .select({ grant: studioBrowserGrants, session: studioBrowserSessions })
    .from(studioBrowserGrants)
    .innerJoin(
      studioBrowserSessions,
      eq(studioBrowserSessions.id, studioBrowserGrants.browserSessionId),
    )
    .where(eq(studioBrowserGrants.id, grantId))
    .limit(1);
  const context = rows[0];
  if (!context) throw invalidGrant();
  if (
    context.grant.userId !== context.session.userId ||
    context.grant.threadId !== context.session.threadId ||
    context.grant.runId !== context.session.runId ||
    context.grant.targetKind !== context.session.targetKind ||
    context.grant.targetResourceId !== context.session.targetResourceId
  ) {
    throw invalidGrant();
  }
  return context;
}

function assertGrantActive(
  context: StudioBrowserGrantContext,
  now: Date,
): void {
  if (
    context.grant.revokedAt ||
    context.grant.expiresAt <= now ||
    context.session.expiresAt <= now ||
    (context.session.status !== "starting" && context.session.status !== "ready")
  ) {
    throw new StudioBrowserError(
      "browser_grant_expired",
      "This Browser preview grant expired.",
      410,
    );
  }
}

async function auditGrantAccess(
  db: Database,
  context: StudioBrowserGrantContext,
  targetKind: string,
  resourceId: string,
  path: string,
) {
  const now = new Date();
  await db.insert(auditLog).values({
    actorUserId: context.grant.userId,
    chatThreadId: context.grant.threadId,
    runId: context.grant.runId,
    actionType: "studio_browser_target_access",
    status: "succeeded",
    provider: "studio-browser-grant",
    metadata: {
      browserSessionId: context.session.id,
      targetKind,
      resourceId,
      path,
    },
    startedAt: now,
    completedAt: now,
  });
}

function isBearerToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{40,128}$/.test(value);
}

function invalidGrant(): StudioBrowserError {
  return new StudioBrowserError(
    "browser_grant_invalid",
    "This Browser preview grant is unavailable.",
    404,
  );
}

function targetMissing(): StudioBrowserError {
  return new StudioBrowserError(
    "browser_target_not_found",
    "This Browser preview target is unavailable.",
    404,
  );
}

function responseTooLarge(): StudioBrowserError {
  return new StudioBrowserError(
    "browser_sandbox_response_too_large",
    "The task sandbox response is too large to preview.",
    413,
  );
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}
