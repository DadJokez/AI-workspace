import {
  type Database,
  oauthTokens,
} from "@ai-workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { GITHUB_API_URL } from "@/lib/deployment-config";
import { decryptSecret } from "@/lib/oauth/crypto";
import { integrationConnectPath } from "@/lib/settings-navigation";
import { loadActiveToolAttestations } from "@/lib/tool-attestations";

const GITHUB_API_VERSION = "2022-11-28";
const REQUIRED_EVENTS = ["pull_request_review", "workflow_run"] as const;
const MAX_HOOK_PAGES = 100;

export interface GitHubTriggerAccessError {
  ok: false;
  status: number;
  error: string;
  message: string;
}

export type GitHubWebhookSubscriptionResult =
  | { ok: true; hookId: number; created: boolean }
  | GitHubTriggerAccessError;

interface GitHubHook {
  id: number;
  active?: boolean;
  events?: string[];
  config?: { url?: string };
}

export async function ensureGitHubRepositoryWebhook({
  db,
  userId,
  repository,
  webhookUrl,
  secret,
  fetchImpl = fetch,
}: {
  db: Database;
  userId: string;
  repository: string;
  webhookUrl: string;
  secret: string;
  fetchImpl?: typeof fetch;
}): Promise<GitHubWebhookSubscriptionResult> {
  if (process.env.E2E_TEST_MODE === "1") {
    return { ok: true, hookId: 293, created: true };
  }

  const access = await resolveGitHubTriggerAccess({ db, userId });
  if (!access.ok) return access;
  return ensureGitHubRepositoryWebhookWithToken({
    accessToken: access.accessToken,
    repository,
    webhookUrl,
    secret,
    fetchImpl,
  });
}

/**
 * The owner's own GitHub token, and only while they hold an unexpired
 * connection and the administrative approval a repository trigger needs. Both
 * ways of receiving events go through this: installing the webhook, and each
 * poll in poll mode, so a revoked approval stops a trigger in either.
 */
export async function resolveGitHubTriggerAccess({
  db,
  userId,
}: {
  db: Database;
  userId: string;
}): Promise<{ ok: true; accessToken: string } | GitHubTriggerAccessError> {
  const [tokenRows, attestations] = await Promise.all([
    db
      .select({
        accessToken: oauthTokens.accessToken,
        expiresAt: oauthTokens.expiresAt,
      })
      .from(oauthTokens)
      .where(
        and(
          eq(oauthTokens.userId, userId),
          eq(oauthTokens.provider, "github"),
          isNull(oauthTokens.revokedAt),
        ),
      )
      .limit(1),
    loadActiveToolAttestations(db, userId),
  ]);
  const tokenRow = tokenRows[0];
  if (!tokenRow) {
    return {
      ok: false,
      status: 409,
      error: "github_not_connected",
      message: `Connect GitHub in ${integrationConnectPath("github")} before adding a GitHub trigger.`,
    };
  }
  if (
    tokenRow.expiresAt &&
    new Date(tokenRow.expiresAt).getTime() <= Date.now()
  ) {
    return {
      ok: false,
      status: 409,
      error: "github_reconnect_required",
      message: "Reconnect GitHub before adding this trigger.",
    };
  }
  const hasAdminApproval = attestations.some(
    (row) =>
      row.provider === "github" &&
      row.scopeType === "provider" &&
      row.action === "admin",
  );
  if (!hasAdminApproval) {
    return {
      ok: false,
      status: 403,
      error: "github_admin_approval_required",
      message: "Approve GitHub administrative access before adding a repository trigger.",
    };
  }

  try {
    return { ok: true, accessToken: decryptSecret(tokenRow.accessToken) };
  } catch {
    return {
      ok: false,
      status: 409,
      error: "github_reconnect_required",
      message: "Reconnect GitHub before adding this trigger.",
    };
  }
}

export async function ensureGitHubRepositoryWebhookWithToken({
  accessToken,
  repository,
  webhookUrl,
  secret,
  fetchImpl = fetch,
}: {
  accessToken: string;
  repository: string;
  webhookUrl: string;
  secret: string;
  fetchImpl?: typeof fetch;
}): Promise<GitHubWebhookSubscriptionResult> {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo || !secret) {
    return {
      ok: false,
      status: 503,
      error: "webhook_not_configured",
      message: "GitHub event triggers are not configured yet.",
    };
  }
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`;
  let existing: GitHubHook | undefined;
  let nextPath: string | undefined = `${path}?per_page=100`;
  const visitedPaths = new Set<string>();
  for (let page = 0; nextPath && page < MAX_HOOK_PAGES; page += 1) {
    if (visitedPaths.has(nextPath)) return githubUnavailable();
    visitedPaths.add(nextPath);

    let listResponse: Response;
    try {
      listResponse = await githubRequest(fetchImpl, accessToken, nextPath);
    } catch {
      return githubUnavailable();
    }
    if (!listResponse.ok) return githubRepositoryError(listResponse.status);

    try {
      const value = (await listResponse.json()) as unknown;
      const hooks = Array.isArray(value) ? value.filter(isGitHubHook) : [];
      existing = hooks.find((hook) => hook.config?.url === webhookUrl);
      if (existing) break;
    } catch {
      return githubUnavailable();
    }

    const parsedNext = nextGitHubApiPath(listResponse.headers.get("link"));
    if (parsedNext === null) return githubUnavailable();
    nextPath = parsedNext;
  }
  if (nextPath && !existing) return githubUnavailable();
  const body = {
    active: true,
    events: [...REQUIRED_EVENTS],
    config: {
      url: webhookUrl,
      content_type: "json",
      insecure_ssl: "0",
      secret,
    },
  };

  let mutationResponse: Response;
  try {
    mutationResponse = await githubRequest(
      fetchImpl,
      accessToken,
      existing ? `${path}/${existing.id}` : path,
      existing ? "PATCH" : "POST",
      existing ? body : { name: "web", ...body },
    );
  } catch {
    return githubUnavailable();
  }
  if (!mutationResponse.ok) {
    return githubRepositoryError(mutationResponse.status);
  }

  try {
    const hook = (await mutationResponse.json()) as unknown;
    if (!isGitHubHook(hook)) return githubUnavailable();
    return { ok: true, hookId: hook.id, created: !existing };
  } catch {
    return githubUnavailable();
  }
}

export function githubRequest(
  fetchImpl: typeof fetch,
  accessToken: string,
  path: string,
  method = "GET",
  body?: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return fetchImpl(`${GITHUB_API_URL}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "Comparative",
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
}

/**
 * The `rel="next"` page as a path under the configured API: undefined when
 * there is no next page, null when the link is malformed or points elsewhere.
 */
export function nextGitHubApiPath(
  linkHeader: string | null,
): string | null | undefined {
  if (!linkHeader) return undefined;
  const segments = linkHeader.split(",");
  const next = segments.find((segment) => /;\s*rel="next"\s*$/.test(segment));
  if (!next) return undefined;
  const match = /^\s*<([^>]+)>/.exec(next);
  if (!match) return null;
  try {
    const url = new URL(match[1]!);
    // GitHub Enterprise Server serves its API under a path (`/api/v3`), which
    // `githubRequest` adds back.
    const api = new URL(GITHUB_API_URL);
    const apiPath = api.pathname.replace(/\/+$/, "");
    if (url.origin !== api.origin || !url.pathname.startsWith(`${apiPath}/`)) {
      return null;
    }
    return `${url.pathname.slice(apiPath.length)}${url.search}`;
  } catch {
    return null;
  }
}

function githubRepositoryError(status: number): GitHubWebhookSubscriptionResult {
  if (status === 401) {
    return {
      ok: false,
      status: 409,
      error: "github_reconnect_required",
      message: "Reconnect GitHub before adding this trigger.",
    };
  }
  if (status === 403 || status === 404) {
    return {
      ok: false,
      status: 403,
      error: "github_repository_admin_required",
      message:
        "Comparative needs repository admin access to install this trigger. Check the repository name and your GitHub access.",
    };
  }
  if (status === 422) {
    return {
      ok: false,
      status: 409,
      error: "github_webhook_conflict",
      message: "GitHub could not install this repository trigger.",
    };
  }
  return githubUnavailable();
}

export function githubUnavailable(): GitHubTriggerAccessError {
  return {
    ok: false,
    status: 502,
    error: "github_unavailable",
    message: "GitHub could not be reached. Try adding the trigger again.",
  };
}

function isGitHubHook(value: unknown): value is GitHubHook {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "number"
  );
}
