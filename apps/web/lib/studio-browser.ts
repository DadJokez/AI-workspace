import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SessionUser } from "@ai-workspace/auth";
import {
  BedrockAgentCoreClient,
  GetBrowserSessionCommand,
  InvokeBrowserCommand,
  StartBrowserSessionCommand,
  StopBrowserSessionCommand,
  type BrowserAction,
} from "@aws-sdk/client-bedrock-agentcore";
import {
  appVersions,
  apps,
  auditLog,
  chatThreads,
  type Database,
  studioBrowserGrants,
  studioBrowserSessions,
  studioSandboxEndpoints,
  workspaceArtifacts,
} from "@ai-workspace/db";
import {
  assertPublicUrlAllowed,
  parsePublicHttpUrl,
  publicUrlReceipt,
} from "@ai-workspace/agent/public-url-policy";
import { Browser } from "bedrock-agentcore/browser";
import { and, eq, inArray, lt, or } from "drizzle-orm";
import { loadThreadMessagesWithRunActivity } from "@/lib/thread-messages";
import { loadWebEgressPolicy } from "@/lib/web-egress-policy";
import {
  STUDIO_BROWSER_GRANT_TTL_SECONDS,
  STUDIO_BROWSER_LIVE_VIEW_TTL_SECONDS,
  STUDIO_BROWSER_SESSION_TTL_SECONDS,
  STUDIO_BROWSER_VIEWPORT,
  isAllowedSandboxPort,
  type StudioBrowserAction,
  type StudioBrowserSessionResponse,
  type StudioBrowserTargetRequest,
} from "@/lib/studio-browser-contract";

const ACTIVE_STATUSES = ["starting", "ready"] as const;

export class StudioBrowserError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "StudioBrowserError";
  }
}

interface BrowserProviderSession {
  providerSessionId: string;
  browserIdentifier: string;
  createdAt: Date;
}

interface StudioBrowserProvider {
  start(input: {
    localSessionId: string;
    name: string;
    timeoutSeconds: number;
    viewport: { width: number; height: number };
  }): Promise<BrowserProviderSession>;
  navigate(input: {
    browserIdentifier: string;
    providerSessionId: string;
    url: string;
  }): Promise<void>;
  action(input: {
    browserIdentifier: string;
    providerSessionId: string;
    action: StudioBrowserAction;
  }): Promise<void>;
  status(input: {
    browserIdentifier: string;
    providerSessionId: string;
  }): Promise<string>;
  liveViewUrl(input: {
    browserIdentifier: string;
    providerSessionId: string;
    expiresInSeconds: number;
  }): Promise<string>;
  screenshot(input: {
    browserIdentifier: string;
    providerSessionId: string;
  }): Promise<Uint8Array>;
  stop(input: {
    browserIdentifier: string;
    providerSessionId: string;
  }): Promise<void>;
}

interface ResolvedTarget {
  kind: "public" | "artifact" | "app" | "sandbox";
  title: string;
  displayUrl: string;
  origin: string;
  resourceId?: string;
  runId?: string;
  publicUrl?: string;
  grant?: {
    kind: "artifact" | "app" | "sandbox";
    resourceId: string;
    targetPath: string;
    sandboxPort?: number;
  };
}

interface StudioBrowserDependencies {
  provider?: StudioBrowserProvider;
  now?: () => Date;
  publicBaseUrl?: string;
}

export function studioBrowserCapabilityFromEnv(): boolean {
  const proxyPort = Number(process.env.AGENTCORE_BROWSER_PROXY_PORT ?? "3128");
  return (
    process.env.AGENTCORE_BROWSER_ENABLED === "1" &&
    Boolean(process.env.AGENTCORE_BROWSER_ID) &&
    Boolean(process.env.AGENTCORE_BROWSER_PROXY_HOST) &&
    Boolean(process.env.AGENTCORE_BROWSER_PROXY_SECRET_ARN) &&
    Number.isInteger(proxyPort) &&
    proxyPort >= 1 &&
    proxyPort <= 65_535
  );
}

export async function startStudioBrowserSession({
  db,
  actor,
  threadId,
  target,
  dependencies = {},
}: {
  db: Database;
  actor: SessionUser;
  threadId: string;
  target: StudioBrowserTargetRequest;
  dependencies?: StudioBrowserDependencies;
}): Promise<StudioBrowserSessionResponse> {
  const now = dependencies.now?.() ?? new Date();
  const publicBaseUrl = resolvePublicBaseUrl(dependencies.publicBaseUrl);
  const localSessionId = randomUUID();
  const expiresAt = new Date(
    now.getTime() + STUDIO_BROWSER_SESSION_TTL_SECONDS * 1000,
  );

  await requireOwnedThread(db, actor.id, threadId);
  const resolved = await resolveTarget({ db, actor, threadId, target, now });
  const provider = dependencies.provider ?? createAgentCoreBrowserProvider();
  await stopSupersededSessions({ db, actor, threadId, provider, now });

  const grant = resolved.grant
    ? createGrant({
        sessionId: localSessionId,
        userId: actor.id,
        threadId,
        runId: resolved.runId,
        target: resolved.grant,
        publicBaseUrl,
        expiresAt: new Date(
          Math.min(
            expiresAt.getTime(),
            now.getTime() + STUDIO_BROWSER_GRANT_TTL_SECONDS * 1000,
          ),
        ),
      })
    : null;
  const navigationUrl = resolved.publicUrl ?? grant?.url;
  if (!navigationUrl) {
    throw new StudioBrowserError(
      "browser_target_unavailable",
      "This Browser target is not available.",
      409,
    );
  }

  let providerSession: BrowserProviderSession | null = null;
  const startedAt = new Date();
  try {
    providerSession = await provider.start({
      localSessionId,
      name: `comparative-${localSessionId.slice(0, 8)}`,
      timeoutSeconds: STUDIO_BROWSER_SESSION_TTL_SECONDS,
      viewport: STUDIO_BROWSER_VIEWPORT,
    });
    await db.transaction(async (tx) => {
      await tx.insert(studioBrowserSessions).values({
        id: localSessionId,
        userId: actor.id,
        threadId,
        runId: resolved.runId,
        providerSessionId: providerSession!.providerSessionId,
        browserIdentifier: providerSession!.browserIdentifier,
        targetKind: resolved.kind,
        targetResourceId: resolved.resourceId,
        displayUrl: resolved.displayUrl,
        origin: resolved.origin,
        status: "starting",
        viewportWidth: STUDIO_BROWSER_VIEWPORT.width,
        viewportHeight: STUDIO_BROWSER_VIEWPORT.height,
        expiresAt,
        metadata: { title: resolved.title },
        createdAt: providerSession!.createdAt,
        updatedAt: now,
      });
      if (grant) {
        await tx.insert(studioBrowserGrants).values(grant.row);
      }
    });

    await provider.navigate({
      browserIdentifier: providerSession.browserIdentifier,
      providerSessionId: providerSession.providerSessionId,
      url: navigationUrl,
    });
    await db
      .update(studioBrowserSessions)
      .set({ status: "ready", updatedAt: new Date() })
      .where(eq(studioBrowserSessions.id, localSessionId));
    await writeBrowserAudit(db, {
      actorUserId: actor.id,
      threadId,
      runId: resolved.runId,
      actionType: "studio_browser_session_start",
      status: "succeeded",
      startedAt,
      metadata: safeTargetMetadata(resolved, localSessionId),
    });

    const liveView = await signedLiveView({
      provider,
      browserIdentifier: providerSession.browserIdentifier,
      providerSessionId: providerSession.providerSessionId,
      now,
    });
    return serializeSession(
      {
        id: localSessionId,
        threadId,
        status: "ready",
        targetKind: resolved.kind,
        displayUrl: resolved.displayUrl,
        origin: resolved.origin,
        expiresAt,
        viewportWidth: STUDIO_BROWSER_VIEWPORT.width,
        viewportHeight: STUDIO_BROWSER_VIEWPORT.height,
      },
      liveView,
    );
  } catch (error) {
    if (providerSession) {
      await provider.stop(providerSession).catch(() => undefined);
      await db
        .update(studioBrowserSessions)
        .set({
          status: "failed",
          lastError: safeErrorMessage(error),
          stoppedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(studioBrowserSessions.id, localSessionId))
        .catch(() => undefined);
    }
    await writeBrowserAudit(db, {
      actorUserId: actor.id,
      threadId,
      runId: resolved.runId,
      actionType: "studio_browser_session_start",
      status: error instanceof StudioBrowserError ? "denied" : "failed",
      startedAt,
      error: safeErrorMessage(error),
      metadata: safeTargetMetadata(resolved, localSessionId),
    }).catch(() => undefined);
    if (error instanceof StudioBrowserError) throw error;
    throw new StudioBrowserError(
      "browser_start_failed",
      "The isolated Browser could not start. Try again in a moment.",
      502,
    );
  }
}

export async function getStudioBrowserSession({
  db,
  actor,
  sessionId,
  dependencies = {},
}: {
  db: Database;
  actor: SessionUser;
  sessionId: string;
  dependencies?: StudioBrowserDependencies;
}): Promise<StudioBrowserSessionResponse> {
  const now = dependencies.now?.() ?? new Date();
  const session = await requireOwnedSession(db, actor.id, sessionId);
  const provider = dependencies.provider ?? createAgentCoreBrowserProvider();
  if (
    session.expiresAt <= now &&
    (session.status === "starting" || session.status === "ready")
  ) {
    await expireSession({ db, session, provider, now });
    return serializeSession({ ...session, status: "expired" });
  }
  if (session.status === "ready" || session.status === "starting") {
    try {
      const providerStatus = await provider.status({
        browserIdentifier: session.browserIdentifier,
        providerSessionId: session.providerSessionId,
      });
      const mapped = mapProviderStatus(providerStatus, session.status);
      if (mapped !== session.status) {
        await db
          .update(studioBrowserSessions)
          .set({ status: mapped, updatedAt: now })
          .where(eq(studioBrowserSessions.id, session.id));
      }
      return serializeSession({ ...session, status: mapped });
    } catch {
      return serializeSession(session);
    }
  }
  return serializeSession(session);
}

export async function getStudioBrowserLiveView({
  db,
  actor,
  sessionId,
  dependencies = {},
}: {
  db: Database;
  actor: SessionUser;
  sessionId: string;
  dependencies?: StudioBrowserDependencies;
}): Promise<StudioBrowserSessionResponse["liveView"]> {
  const now = dependencies.now?.() ?? new Date();
  const session = await requireActiveOwnedSession(db, actor.id, sessionId, now);
  const provider = dependencies.provider ?? createAgentCoreBrowserProvider();
  return signedLiveView({
    provider,
    browserIdentifier: session.browserIdentifier,
    providerSessionId: session.providerSessionId,
    now,
  });
}

export async function runStudioBrowserAction({
  db,
  actor,
  sessionId,
  action,
  dependencies = {},
}: {
  db: Database;
  actor: SessionUser;
  sessionId: string;
  action: StudioBrowserAction;
  dependencies?: StudioBrowserDependencies;
}): Promise<void> {
  const now = dependencies.now?.() ?? new Date();
  const session = await requireActiveOwnedSession(db, actor.id, sessionId, now);
  const provider = dependencies.provider ?? createAgentCoreBrowserProvider();
  await provider.action({
    browserIdentifier: session.browserIdentifier,
    providerSessionId: session.providerSessionId,
    action,
  });
  await writeBrowserAudit(db, {
    actorUserId: actor.id,
    threadId: session.threadId,
    runId: session.runId ?? undefined,
    actionType: `studio_browser_${action}`,
    status: "succeeded",
    metadata: {
      browserSessionId: session.id,
      targetKind: session.targetKind,
      origin: session.origin,
    },
  });
}

export async function getStudioBrowserScreenshot({
  db,
  actor,
  sessionId,
  dependencies = {},
}: {
  db: Database;
  actor: SessionUser;
  sessionId: string;
  dependencies?: StudioBrowserDependencies;
}): Promise<Uint8Array> {
  const now = dependencies.now?.() ?? new Date();
  const session = await requireActiveOwnedSession(db, actor.id, sessionId, now);
  const provider = dependencies.provider ?? createAgentCoreBrowserProvider();
  return provider.screenshot({
    browserIdentifier: session.browserIdentifier,
    providerSessionId: session.providerSessionId,
  });
}

export async function stopStudioBrowserSession({
  db,
  actor,
  sessionId,
  dependencies = {},
}: {
  db: Database;
  actor: SessionUser;
  sessionId: string;
  dependencies?: StudioBrowserDependencies;
}): Promise<void> {
  const session = await requireOwnedSession(db, actor.id, sessionId);
  const provider = dependencies.provider ?? createAgentCoreBrowserProvider();
  const stoppedAt = new Date();
  await db
    .update(studioBrowserSessions)
    .set({ status: "stopping", updatedAt: stoppedAt })
    .where(eq(studioBrowserSessions.id, session.id));
  await provider
    .stop({
      browserIdentifier: session.browserIdentifier,
      providerSessionId: session.providerSessionId,
    })
    .catch(() => undefined);
  await db.transaction(async (tx) => {
    await tx
      .update(studioBrowserSessions)
      .set({ status: "stopped", stoppedAt, updatedAt: stoppedAt })
      .where(eq(studioBrowserSessions.id, session.id));
    await tx
      .update(studioBrowserGrants)
      .set({ revokedAt: stoppedAt })
      .where(
        and(
          eq(studioBrowserGrants.browserSessionId, session.id),
          eq(studioBrowserGrants.userId, actor.id),
        ),
      );
  });
  await writeBrowserAudit(db, {
    actorUserId: actor.id,
    threadId: session.threadId,
    runId: session.runId ?? undefined,
    actionType: "studio_browser_session_stop",
    status: "succeeded",
    metadata: { browserSessionId: session.id },
  });
}

function createAgentCoreBrowserProvider(): StudioBrowserProvider {
  if (!studioBrowserCapabilityFromEnv()) {
    throw new StudioBrowserError(
      "browser_unavailable",
      "The isolated Browser is not available in this environment.",
      503,
    );
  }
  const region = process.env.AWS_REGION ?? "us-east-1";
  const identifier = process.env.AGENTCORE_BROWSER_ID!;
  const proxyHost = process.env.AGENTCORE_BROWSER_PROXY_HOST!;
  const proxyPort = Number(process.env.AGENTCORE_BROWSER_PROXY_PORT ?? "3128");
  const proxySecretArn = process.env.AGENTCORE_BROWSER_PROXY_SECRET_ARN!;
  const client = new BedrockAgentCoreClient({ region });

  async function invoke(
    browserIdentifier: string,
    providerSessionId: string,
    action: BrowserAction,
  ) {
    await client.send(
      new InvokeBrowserCommand({
        browserIdentifier,
        sessionId: providerSessionId,
        action,
      }),
    );
  }

  return {
    async start(input) {
      const response = await client.send(
        new StartBrowserSessionCommand({
          browserIdentifier: identifier,
          name: input.name,
          sessionTimeoutSeconds: input.timeoutSeconds,
          viewPort: input.viewport,
          clientToken: input.localSessionId,
          proxyConfiguration: {
            proxies: [
              {
                externalProxy: {
                  server: proxyHost,
                  port: proxyPort,
                  credentials: {
                    basicAuth: { secretArn: proxySecretArn },
                  },
                },
              },
            ],
          },
        }),
      );
      if (!response.sessionId || !response.browserIdentifier) {
        throw new Error("AgentCore did not return a Browser session id.");
      }
      return {
        providerSessionId: response.sessionId,
        browserIdentifier: response.browserIdentifier,
        createdAt: response.createdAt ?? new Date(),
      };
    },
    async navigate(input) {
      await invoke(input.browserIdentifier, input.providerSessionId, {
        keyShortcut: { keys: ["CTRL", "L"] },
      });
      await invoke(input.browserIdentifier, input.providerSessionId, {
        keyType: { text: input.url },
      });
      await invoke(input.browserIdentifier, input.providerSessionId, {
        keyPress: { key: "ENTER" },
      });
    },
    async action(input) {
      const action: BrowserAction =
        input.action === "back"
          ? { keyShortcut: { keys: ["ALT", "LEFT"] } }
          : input.action === "forward"
            ? { keyShortcut: { keys: ["ALT", "RIGHT"] } }
            : { keyShortcut: { keys: ["CTRL", "R"] } };
      await invoke(input.browserIdentifier, input.providerSessionId, action);
    },
    async status(input) {
      const response = await client.send(
        new GetBrowserSessionCommand({
          browserIdentifier: input.browserIdentifier,
          sessionId: input.providerSessionId,
        }),
      );
      return response.status ?? "UNKNOWN";
    },
    async liveViewUrl(input) {
      const browser = new Browser({
        region,
        identifier: input.browserIdentifier,
      });
      browser.attachSession(input.providerSessionId);
      return browser.generateLiveViewUrl(input.expiresInSeconds);
    },
    async screenshot(input) {
      const response = await client.send(
        new InvokeBrowserCommand({
          browserIdentifier: input.browserIdentifier,
          sessionId: input.providerSessionId,
          action: { screenshot: { format: "PNG" } },
        }),
      );
      if (!("screenshot" in (response.result ?? {}))) {
        throw new Error("AgentCore did not return a Browser screenshot.");
      }
      const data = response.result?.screenshot?.data;
      if (!data) throw new Error("AgentCore returned an empty Browser screenshot.");
      return data;
    },
    async stop(input) {
      await client.send(
        new StopBrowserSessionCommand({
          browserIdentifier: input.browserIdentifier,
          sessionId: input.providerSessionId,
        }),
      );
    },
  };
}

async function resolveTarget({
  db,
  actor,
  threadId,
  target,
  now,
}: {
  db: Database;
  actor: SessionUser;
  threadId: string;
  target: StudioBrowserTargetRequest;
  now: Date;
}): Promise<ResolvedTarget> {
  if (target.kind === "evidence") {
    const messages = await loadThreadMessagesWithRunActivity({
      db,
      threadId,
      actor,
    });
    const message = messages.find(
      (candidate) => candidate.id === target.messageId,
    );
    const source = message?.sources?.find(
      (candidate) => candidate.n === target.sourceNumber,
    );
    if (!message || !source?.url) {
      throw new StudioBrowserError(
        "browser_target_not_found",
        "That cited source is no longer available in this chat.",
        404,
      );
    }
    const url = parsePublicHttpUrl(source.url);
    await assertPublicUrlAllowed({
      url,
      egressPolicy: await loadWebEgressPolicy(db),
    }).catch((error) => {
      throw new StudioBrowserError(
        "browser_target_blocked",
        safeBlockedMessage(error),
        403,
      );
    });
    const receipt = publicUrlReceipt(url.toString());
    return {
      kind: "public",
      title: source.title,
      displayUrl: receipt.displayUrl,
      origin: receipt.origin,
      runId: message.runId,
      resourceId: `${message.id}:${source.n}`,
      publicUrl: url.toString(),
    };
  }

  if (target.kind === "artifact") {
    const rows = await db
      .select()
      .from(workspaceArtifacts)
      .where(
        and(
          eq(workspaceArtifacts.id, target.artifactId),
          eq(workspaceArtifacts.userId, actor.id),
          eq(workspaceArtifacts.threadId, threadId),
        ),
      )
      .limit(1);
    const artifact = rows[0];
    if (!artifact) throw targetNotFound();
    return {
      kind: "artifact",
      title: artifact.title,
      displayUrl: `/workspace/artifacts/${artifact.id}`,
      origin: "comparative://artifact",
      resourceId: artifact.id,
      runId: artifact.runId ?? undefined,
      grant: {
        kind: "artifact",
        resourceId: artifact.id,
        targetPath: "/",
      },
    };
  }

  if (target.kind === "app") {
    const rows = await db
      .select({
        version: appVersions,
        app: apps,
      })
      .from(appVersions)
      .innerJoin(apps, eq(apps.id, appVersions.appId))
      .where(
        and(
          eq(appVersions.id, target.appVersionId),
          eq(apps.ownerUserId, actor.id),
          or(
            eq(appVersions.sourceThreadId, threadId),
            eq(apps.sourceThreadId, threadId),
          ),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw targetNotFound();
    const artifactRows = await db
      .select({ runId: workspaceArtifacts.runId })
      .from(workspaceArtifacts)
      .where(eq(workspaceArtifacts.id, row.version.artifactId))
      .limit(1);
    return {
      kind: "app",
      title: row.app.name,
      displayUrl: `/apps/${row.app.slug}`,
      origin: "comparative://app",
      resourceId: row.version.id,
      runId: artifactRows[0]?.runId ?? undefined,
      grant: {
        kind: "app",
        resourceId: row.version.id,
        targetPath: "/",
      },
    };
  }

  const rows = await db
    .select()
    .from(studioSandboxEndpoints)
    .where(
      and(
        eq(studioSandboxEndpoints.id, target.sandboxId),
        eq(studioSandboxEndpoints.userId, actor.id),
        eq(studioSandboxEndpoints.threadId, threadId),
        eq(studioSandboxEndpoints.status, "active"),
      ),
    )
    .limit(1);
  const sandbox = rows[0];
  const ports = Array.isArray(sandbox?.allowedPorts)
    ? sandbox.allowedPorts.filter(isAllowedSandboxPort)
    : [];
  if (!sandbox || sandbox.expiresAt <= now || !ports.includes(target.port)) {
    throw targetNotFound();
  }
  return {
    kind: "sandbox",
    title: `Sandbox app on port ${target.port}`,
    displayUrl: `sandbox://localhost:${target.port}/`,
    origin: `sandbox://localhost:${target.port}`,
    resourceId: sandbox.id,
    runId: sandbox.runId ?? undefined,
    grant: {
      kind: "sandbox",
      resourceId: sandbox.id,
      targetPath: "/",
      sandboxPort: target.port,
    },
  };
}

function createGrant({
  sessionId,
  userId,
  threadId,
  runId,
  target,
  publicBaseUrl,
  expiresAt,
}: {
  sessionId: string;
  userId: string;
  threadId: string;
  runId?: string;
  target: NonNullable<ResolvedTarget["grant"]>;
  publicBaseUrl: string;
  expiresAt: Date;
}) {
  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  return {
    url: studioBrowserGrantUrl(publicBaseUrl, id, token),
    row: {
      id,
      browserSessionId: sessionId,
      userId,
      threadId,
      runId,
      targetKind: target.kind,
      targetResourceId: target.resourceId,
      targetPath: target.targetPath,
      sandboxPort: target.sandboxPort,
      tokenHash: hashGrantToken(token),
      expiresAt,
    },
  };
}

export function studioBrowserGrantUrl(
  publicBaseUrl: string,
  grantId: string,
  token: string,
): string {
  const url = new URL(
    `/api/studio/browser/grants/${encodeURIComponent(grantId)}`,
    publicBaseUrl,
  );
  url.hash = new URLSearchParams({ grant: token }).toString();
  return url.toString();
}

export function hashGrantToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function signedLiveView({
  provider,
  browserIdentifier,
  providerSessionId,
  now,
}: {
  provider: StudioBrowserProvider;
  browserIdentifier: string;
  providerSessionId: string;
  now: Date;
}) {
  const signedUrl = await provider.liveViewUrl({
    browserIdentifier,
    providerSessionId,
    expiresInSeconds: STUDIO_BROWSER_LIVE_VIEW_TTL_SECONDS,
  });
  return {
    signedUrl,
    expiresAt: new Date(
      now.getTime() + STUDIO_BROWSER_LIVE_VIEW_TTL_SECONDS * 1000,
    ).toISOString(),
  };
}

async function requireOwnedThread(
  db: Database,
  userId: string,
  threadId: string,
) {
  const rows = await db
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .limit(1);
  if (!rows[0]) {
    throw new StudioBrowserError(
      "browser_thread_not_found",
      "This chat is not available.",
      404,
    );
  }
}

async function requireOwnedSession(
  db: Database,
  userId: string,
  sessionId: string,
) {
  const rows = await db
    .select()
    .from(studioBrowserSessions)
    .where(
      and(
        eq(studioBrowserSessions.id, sessionId),
        eq(studioBrowserSessions.userId, userId),
      ),
    )
    .limit(1);
  if (!rows[0]) {
    throw new StudioBrowserError(
      "browser_session_not_found",
      "This Browser session is not available.",
      404,
    );
  }
  return rows[0];
}

async function requireActiveOwnedSession(
  db: Database,
  userId: string,
  sessionId: string,
  now: Date,
) {
  const session = await requireOwnedSession(db, userId, sessionId);
  if (session.expiresAt <= now) {
    throw new StudioBrowserError(
      "browser_session_expired",
      "This Browser session expired. Reopen the source to start a fresh one.",
      410,
    );
  }
  if (session.status !== "ready" && session.status !== "starting") {
    throw new StudioBrowserError(
      "browser_session_inactive",
      "This Browser session is no longer active.",
      409,
    );
  }
  return session;
}

async function stopSupersededSessions({
  db,
  actor,
  threadId,
  provider,
  now,
}: {
  db: Database;
  actor: SessionUser;
  threadId: string;
  provider: StudioBrowserProvider;
  now: Date;
}) {
  const sessions = await db
    .select()
    .from(studioBrowserSessions)
    .where(
      and(
        eq(studioBrowserSessions.userId, actor.id),
        eq(studioBrowserSessions.threadId, threadId),
        inArray(studioBrowserSessions.status, [...ACTIVE_STATUSES]),
      ),
    )
    .limit(3);
  for (const session of sessions) {
    await provider
      .stop({
        browserIdentifier: session.browserIdentifier,
        providerSessionId: session.providerSessionId,
      })
      .catch(() => undefined);
  }
  if (sessions.length === 0) return;
  const ids = sessions.map((session) => session.id);
  await db.transaction(async (tx) => {
    await tx
      .update(studioBrowserSessions)
      .set({ status: "stopped", stoppedAt: now, updatedAt: now })
      .where(inArray(studioBrowserSessions.id, ids));
    await tx
      .update(studioBrowserGrants)
      .set({ revokedAt: now })
      .where(inArray(studioBrowserGrants.browserSessionId, ids));
  });
}

async function expireSession({
  db,
  session,
  provider,
  now,
}: {
  db: Database;
  session: typeof studioBrowserSessions.$inferSelect;
  provider: StudioBrowserProvider;
  now: Date;
}) {
  await provider
    .stop({
      browserIdentifier: session.browserIdentifier,
      providerSessionId: session.providerSessionId,
    })
    .catch(() => undefined);
  await db.transaction(async (tx) => {
    await tx
      .update(studioBrowserSessions)
      .set({ status: "expired", stoppedAt: now, updatedAt: now })
      .where(eq(studioBrowserSessions.id, session.id));
    await tx
      .update(studioBrowserGrants)
      .set({ revokedAt: now })
      .where(eq(studioBrowserGrants.browserSessionId, session.id));
  });
}

function serializeSession(
  session: Pick<
    typeof studioBrowserSessions.$inferSelect,
    | "id"
    | "threadId"
    | "status"
    | "targetKind"
    | "displayUrl"
    | "origin"
    | "expiresAt"
    | "viewportWidth"
    | "viewportHeight"
  >,
  liveView?: StudioBrowserSessionResponse["liveView"],
): StudioBrowserSessionResponse {
  return {
    id: session.id,
    threadId: session.threadId,
    status: session.status as StudioBrowserSessionResponse["status"],
    targetKind: session.targetKind as StudioBrowserSessionResponse["targetKind"],
    displayUrl: session.displayUrl,
    origin: session.origin,
    expiresAt: session.expiresAt.toISOString(),
    viewport: {
      width: session.viewportWidth,
      height: session.viewportHeight,
    },
    ...(liveView ? { liveView } : {}),
    ...(!liveView || session.status !== "ready"
      ? {
          fallback: {
            title: "Live Browser unavailable",
            detail:
              "The source receipt remains available while the isolated session reconnects or expires.",
          },
        }
      : {}),
  };
}

function mapProviderStatus(providerStatus: string, current: string): string {
  const normalized = providerStatus.toUpperCase();
  if (normalized === "STOPPED" || normalized === "TERMINATED") return "stopped";
  if (normalized === "STOPPING") return "stopping";
  if (normalized === "FAILED") return "failed";
  if (normalized === "ACTIVE" || normalized === "READY") return "ready";
  return current;
}

function resolvePublicBaseUrl(explicit?: string): string {
  const candidate = explicit ?? process.env.NEXTAUTH_URL;
  if (!candidate) {
    throw new StudioBrowserError(
      "browser_config_error",
      "The Browser public origin is not configured.",
      503,
    );
  }
  return new URL(candidate).origin;
}

function targetNotFound() {
  return new StudioBrowserError(
    "browser_target_not_found",
    "This Browser target is not available in the current chat.",
    404,
  );
}

function safeBlockedMessage(error: unknown): string {
  const message = safeErrorMessage(error);
  return message.includes("web_egress_denied")
    ? "This site is blocked by the workspace web policy."
    : "This address is not permitted in the isolated Browser.";
}

function safeErrorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value
    .replace(/([?&](?:token|key|secret|code|grant)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/https?:\/\/[^\s]+/gi, (url) => {
      try {
        return publicUrlReceipt(url).displayUrl;
      } catch {
        return "[redacted-url]";
      }
    })
    .slice(0, 500);
}

function safeTargetMetadata(target: ResolvedTarget, sessionId: string) {
  return {
    browserSessionId: sessionId,
    targetKind: target.kind,
    targetResourceId: target.resourceId,
    origin: target.origin,
    displayUrl: target.displayUrl,
  };
}

async function writeBrowserAudit(
  db: Database,
  input: {
    actorUserId: string;
    threadId: string;
    runId?: string;
    actionType: string;
    status: "started" | "succeeded" | "failed" | "denied";
    startedAt?: Date;
    error?: string;
    metadata?: Record<string, unknown>;
  },
) {
  await db.insert(auditLog).values({
    actorUserId: input.actorUserId,
    chatThreadId: input.threadId,
    runId: input.runId,
    actionType: input.actionType,
    status: input.status,
    provider: "agentcore-browser",
    error: input.error,
    metadata: input.metadata,
    startedAt: input.startedAt,
    completedAt: new Date(),
  });
}

/** Mark stale rows even when no user opens Studio again. Called by operators. */
export async function expireStaleStudioBrowserRows(
  db: Database,
  now = new Date(),
) {
  await db
    .update(studioBrowserSessions)
    .set({ status: "expired", stoppedAt: now, updatedAt: now })
    .where(
      and(
        inArray(studioBrowserSessions.status, [...ACTIVE_STATUSES]),
        lt(studioBrowserSessions.expiresAt, now),
      ),
    );
  await db
    .update(studioBrowserGrants)
    .set({ revokedAt: now })
    .where(lt(studioBrowserGrants.expiresAt, now));
}
