import type { SessionUser } from "@ai-workspace/auth";
import {
  apps,
  chatThreads,
  type Database,
  type Skill,
  skills,
} from "@ai-workspace/db";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import {
  canAppRoleEdit,
  listAppVersions,
  listAppSharesWithRoles,
  type AppActorRole,
} from "@/lib/apps";
import type {
  CommandPaletteGroupId,
  CommandPaletteReadiness,
  CommandPaletteServerItem,
} from "@/lib/command-palette";
import {
  SUPPORTED_MCP_PROVIDERS,
  loadUserMcpProviderStatus,
  type UserMcpProviderStatus,
} from "@/lib/oauth/mcp-servers";
import { outputProposalFromMetadata } from "@/lib/output-proposals";
import { listSkillsSharedWith } from "@/lib/shares";
import { INTEGRATION_DISPLAY_NAMES } from "@/lib/settings-navigation";
import { canonicalizeStarterSkill } from "@/lib/starter-skills";
import { loadToolCatalogForProviders } from "@/lib/tool-attestations";
import { loadUserMemoryItems } from "@/lib/vault-memory";
import {
  loadWorkspaceArtifacts,
  type WorkspaceArtifactSummary,
} from "@/lib/workspace-artifacts";

const MAX_THREADS = 50;
const MAX_ARTIFACTS = 75;
const MAX_APPS = 30;
const MAX_APP_VERSIONS_PER_APP = 8;

interface VisibleApp {
  app: typeof apps.$inferSelect;
  role: AppActorRole;
}

export interface CommandPaletteIndex {
  items: CommandPaletteServerItem[];
  partialSections: CommandPaletteGroupId[];
}

/**
 * Build the caller's palette index. Every query is scoped here, before labels
 * or snippets cross the server boundary; the client never filters permissions.
 */
export async function loadCommandPaletteIndex({
  db,
  user,
  currentThreadId,
}: {
  db: Database;
  user: SessionUser;
  currentThreadId?: string;
}): Promise<CommandPaletteIndex> {
  const partial = new Set<CommandPaletteGroupId>();
  const [
    threadRows,
    artifacts,
    memoryItems,
    visibleSkills,
    visibleApps,
    providerStatus,
    catalog,
  ] = await Promise.all([
      settle(
        () => loadThreads(db, user.id),
        partial,
        ["chats"],
      ),
      settle(
        () =>
          loadWorkspaceArtifacts({
            db,
            userId: user.id,
            limit: MAX_ARTIFACTS,
          }),
        partial,
        ["files", "review"],
      ),
      settle(
        () => loadUserMemoryItems(db, user.id, ["approved"]),
        partial,
        ["vault"],
      ),
      settle(
        () => loadVisibleSkills(db, user.id),
        partial,
        ["skills"],
      ),
      settle(
        () => loadVisibleApps(db, user.id),
        partial,
        ["apps", "review"],
      ),
      settle(
        () => loadUserMcpProviderStatus(db, user.id),
        partial,
        ["tools", "skills"],
      ),
      settle(
        () => loadToolCatalogForProviders(db, SUPPORTED_MCP_PROVIDERS),
        partial,
        ["tools"],
      ),
    ]);

  const threads = threadRows ?? [];
  const threadTitleById = new Map(
    threads.map((thread) => [thread.id, thread.title?.trim() || "Untitled"]),
  );
  const items: CommandPaletteServerItem[] = [
    ...threadItems(threads, currentThreadId),
    ...artifactItems(artifacts ?? [], threadTitleById, currentThreadId),
    ...vaultItems(memoryItems ?? [], currentThreadId),
    ...skillItems(visibleSkills ?? [], providerStatus),
    ...appItems(visibleApps ?? []),
    ...toolItems(providerStatus, catalog ?? []),
  ];

  if (visibleApps) {
    const versionItems = await settle(
      () => appVersionItems(db, visibleApps, user.id),
      partial,
      ["apps", "review"],
    );
    if (versionItems) items.push(...versionItems);
  }

  return {
    items,
    partialSections: [...partial].sort(),
  };
}

async function settle<T>(
  load: () => Promise<T>,
  partial: Set<CommandPaletteGroupId>,
  sections: readonly CommandPaletteGroupId[],
): Promise<T | undefined> {
  try {
    return await load();
  } catch (error) {
    for (const section of sections) partial.add(section);
    console.warn(
      `[command-palette] ${sections.join(",")} index section failed:`,
      error,
    );
    return undefined;
  }
}

async function loadThreads(db: Database, userId: string) {
  return db
    .select({
      id: chatThreads.id,
      title: chatThreads.title,
      previewSummary: chatThreads.previewSummary,
      updatedAt: chatThreads.updatedAt,
    })
    .from(chatThreads)
    .where(eq(chatThreads.userId, userId))
    .orderBy(desc(chatThreads.pinned), desc(chatThreads.updatedAt))
    .limit(MAX_THREADS);
}

async function loadVisibleSkills(
  db: Database,
  userId: string,
): Promise<Skill[]> {
  const [ownedOrStarter, shared] = await Promise.all([
    db
      .select()
      .from(skills)
      .where(
        and(
          isNull(skills.archivedAt),
          or(eq(skills.ownerUserId, userId), eq(skills.isStarter, true)),
        ),
      )
      .orderBy(desc(skills.updatedAt)),
    listSkillsSharedWith(db, userId),
  ]);
  const seen = new Set<string>();
  return [...ownedOrStarter, ...shared]
    .filter((skill) => {
      if (seen.has(skill.id)) return false;
      seen.add(skill.id);
      return true;
    })
    .map(canonicalizeStarterSkill);
}

async function loadVisibleApps(
  db: Database,
  userId: string,
): Promise<VisibleApp[]> {
  const [mine, shared] = await Promise.all([
    db
      .select()
      .from(apps)
      .where(and(eq(apps.ownerUserId, userId), isNull(apps.archivedAt)))
      .orderBy(desc(apps.updatedAt))
      .limit(MAX_APPS),
    listAppSharesWithRoles(db, userId),
  ]);
  const visible: VisibleApp[] = mine.map((app) => ({ app, role: "owner" }));
  const seen = new Set(mine.map((app) => app.id));
  for (const { app, role } of shared) {
    if (seen.has(app.id) || visible.length >= MAX_APPS) continue;
    seen.add(app.id);
    visible.push({ app, role });
  }
  return visible;
}

function threadItems(
  threads: Awaited<ReturnType<typeof loadThreads>>,
  currentThreadId?: string,
): CommandPaletteServerItem[] {
  return threads.map((thread, index) => {
    const title = thread.title?.trim() || "Untitled";
    return {
      id: `thread:${thread.id}`,
      group: "chats",
      label: title,
      description: thread.previewSummary,
      keywords: ["conversation", "thread"],
      priority: thread.id === currentThreadId ? 40 : Math.max(0, 20 - index),
      command: { type: "thread", threadId: thread.id, title },
    };
  });
}

function artifactItems(
  artifacts: readonly WorkspaceArtifactSummary[],
  threadTitleById: ReadonlyMap<string, string>,
  currentThreadId?: string,
): CommandPaletteServerItem[] {
  const latest = new Map<string, WorkspaceArtifactSummary>();
  for (const artifact of artifacts) {
    const key = artifact.artifactGroupId || artifact.id;
    if (!latest.has(key)) latest.set(key, artifact);
  }

  const items: CommandPaletteServerItem[] = [];
  let index = 0;
  for (const artifact of latest.values()) {
    const safeArtifact = paletteArtifact(artifact);
    const threadTitle = artifact.threadId
      ? threadTitleById.get(artifact.threadId)
      : undefined;
    const command = {
      type: "artifact" as const,
      artifact: safeArtifact,
      ...(threadTitle ? { threadTitle } : {}),
    };
    items.push({
      id: `artifact:${artifact.id}`,
      group: "files",
      label: artifact.title,
      description: [
        artifact.filename,
        artifact.versionNumber > 1 ? `v${artifact.versionNumber}` : null,
        artifact.versionSummary,
      ]
        .filter(Boolean)
        .join(" · "),
      keywords: [
        artifact.kind,
        artifact.mimeType,
        "artifact",
        "file",
        "document",
      ],
      priority:
        artifact.threadId === currentThreadId
          ? 35
          : Math.max(0, 16 - index),
      command,
    });
    index += 1;

    const proposal = outputProposalFromMetadata(artifact.metadata);
    if (proposal?.status === "proposed" || proposal?.status === "iterating") {
      items.push({
        id: `review:artifact:${artifact.id}`,
        group: "review",
        label: `Review ${artifact.title}`,
        description:
          proposal.status === "iterating"
            ? "A requested revision is in progress."
            : "Unattended output is waiting for your decision.",
        keywords: ["proposal", "approval", "pending output", artifact.filename],
        priority: artifact.threadId === currentThreadId ? 40 : 24,
        readiness: {
          state: "review_required",
          label: proposal.status === "iterating" ? "Revising" : "Review",
          detail: "Open the output in Contribution Studio.",
        },
        command,
      });
    }
  }
  return items;
}

function paletteArtifact(
  artifact: WorkspaceArtifactSummary,
): WorkspaceArtifactSummary {
  // Proposal metadata is intentionally interpreted on the server and omitted
  // from the global search payload. The preview route re-authorizes details.
  return { ...artifact, metadata: null };
}

function vaultItems(
  items: Awaited<ReturnType<typeof loadUserMemoryItems>>,
  currentThreadId?: string,
): CommandPaletteServerItem[] {
  return [...items]
    .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
    .map((item, index) => ({
      id: `vault:${item.id}`,
      group: "vault" as const,
      label: item.title,
      description: truncate(item.bodyMd, 150),
      keywords: [item.category, "memory", "vault", "personal context"],
      priority:
        item.sourceThreadId === currentThreadId
          ? 30
          : Math.max(0, 12 - index),
      command: {
        type: "settings" as const,
        section: "memory" as const,
        focusId: item.id,
      },
    }));
}

function skillItems(
  skills: readonly Skill[],
  providerStatus: UserMcpProviderStatus | undefined,
): CommandPaletteServerItem[] {
  return skills.map((skill, index) => {
    const providers = skill.mcpProviders ?? [];
    const readiness = resolveSkillReadiness(providers, providerStatus);
    return {
      id: `skill:${skill.id}`,
      group: "skills",
      label: skill.name,
      description:
        readiness.state === "ready" ? skill.description : readiness.detail,
      keywords: ["agent", "skill", "run", ...providers],
      priority: Math.max(0, 12 - index),
      readiness,
      command:
        readiness.state === "ready"
          ? {
              type: "run-skill" as const,
              skillId: skill.id,
              skillName: skill.name,
            }
          : { type: "settings" as const, section: "integrations" as const },
    };
  });
}

function appItems(
  visibleApps: readonly VisibleApp[],
): CommandPaletteServerItem[] {
  return visibleApps.map(({ app, role }, index) => {
    const canManage = canAppRoleEdit(role);
    const href =
      app.status === "deployed" && (app.liveVersionId || app.liveArtifactId)
        ? `/apps/${app.slug}`
        : canManage
          ? `/apps/manage/${app.id}`
          : "/apps";
    return {
      id: `app:${app.id}`,
      group: "apps",
      label: app.name,
      description:
        app.description ??
        (app.status === "deployed" ? "Published app" : "App draft"),
      keywords: ["application", "published app", app.status],
      priority: Math.max(0, 12 - index),
      command: { type: "route", href },
    };
  });
}

async function appVersionItems(
  db: Database,
  visibleApps: readonly VisibleApp[],
  userId: string,
): Promise<CommandPaletteServerItem[]> {
  const editable = visibleApps.filter(({ role }) => canAppRoleEdit(role));
  const versions = await Promise.all(
    editable.map(async ({ app, role }) => ({
      app,
      rows: await listAppVersions(db, {
        appId: app.id,
        visibleToUserId: userId,
        actorRole: role,
        limit: MAX_APP_VERSIONS_PER_APP,
      }),
    })),
  );

  return versions.flatMap(({ app, rows }) =>
    rows.map((version, index): CommandPaletteServerItem => {
      const review = version.status === "proposed";
      return {
        id: `${review ? "review" : "app-version"}:${version.id}`,
        group: review ? "review" : "apps",
        label: review
          ? `Review ${app.name} v${version.versionNumber}`
          : `${app.name} v${version.versionNumber}`,
        description:
          version.summary ??
          `${version.artifactFilename} · ${version.status}`,
        keywords: [
          "app version",
          version.artifactFilename,
          version.status,
          review ? "proposal approval pending output" : "",
        ],
        priority: review ? 26 : Math.max(0, 8 - index),
        ...(review
          ? {
              readiness: {
                state: "review_required" as const,
                label: "Review",
                detail:
                  "Open the app version to accept, revise, or discard it.",
              },
            }
          : {}),
        command: {
          type: "route",
          href: `/apps/manage/${app.id}#app-version-${version.id}`,
        },
      };
    }),
  );
}

function toolItems(
  providerStatus: UserMcpProviderStatus | undefined,
  catalog: Awaited<ReturnType<typeof loadToolCatalogForProviders>>,
): CommandPaletteServerItem[] {
  const providers = SUPPORTED_MCP_PROVIDERS.map(
    (provider): CommandPaletteServerItem => ({
      id: `provider:${provider}`,
      group: "tools",
      label: providerLabel(provider),
      description: providerReadiness(provider, providerStatus).detail,
      keywords: [provider, "provider", "integration", "connect tool"],
      priority: providerStatus?.connectedProviders.includes(provider) ? 16 : 0,
      readiness: providerReadiness(provider, providerStatus),
      command: { type: "settings", section: "integrations" },
    }),
  );

  const tools = catalog
    .slice()
    .sort(
      (left, right) =>
        left.provider.localeCompare(right.provider) ||
        left.toolName.localeCompare(right.toolName),
    )
    .map((tool): CommandPaletteServerItem => ({
      id: `tool:${tool.provider}:${tool.toolName}`,
      group: "tools",
      label: humanize(tool.toolName),
      description: `${providerLabel(tool.provider)} · ${humanize(tool.category)} · ${humanize(tool.action)}`,
      keywords: [tool.provider, tool.toolName, tool.category, "tool"],
      priority: providerStatus?.allowedProviders.includes(tool.provider)
        ? 12
        : 0,
      readiness: toolReadiness(tool, providerStatus),
      command: { type: "settings", section: "integrations" },
    }));

  return [...providers, ...tools];
}

export function resolveSkillReadiness(
  providers: readonly string[],
  status: UserMcpProviderStatus | undefined,
): CommandPaletteReadiness {
  if (providers.length === 0) {
    return { state: "ready", label: "Run", detail: "Run this Skill now." };
  }
  const readiness = providers.map((provider) =>
    providerReadiness(provider, status),
  );
  const firstBlocked = [
    "connection_required",
    "reconnect_required",
    "approval_required",
    "policy_blocked",
    "unavailable",
  ]
    .map((state) => readiness.find((entry) => entry.state === state))
    .find(Boolean);
  return (
    firstBlocked ?? {
      state: "ready",
      label: "Run",
      detail: `Run with ${providers.map(providerLabel).join(", ")}.`,
    }
  );
}

export function providerReadiness(
  provider: string,
  status: UserMcpProviderStatus | undefined,
): CommandPaletteReadiness {
  const name = providerLabel(provider);
  if (!status) {
    return {
      state: "unavailable",
      label: "Unavailable",
      detail: `${name} readiness could not be checked. Try again.`,
    };
  }
  const availability = status.providerAvailability?.[provider];
  if (!availability?.connected) {
    return {
      state: "connection_required",
      label: "Connect",
      detail: `Connect ${name} in Settings → Integrations.`,
    };
  }
  if (availability.status === "reconnect_required") {
    return {
      state: "reconnect_required",
      label: "Reconnect",
      detail: `Reconnect ${name} in Settings → Integrations.`,
    };
  }
  if (availability.status === "pending_approval") {
    return {
      state: "approval_required",
      label: "Needs approval",
      detail: `${name} is connected but pending workspace approval.`,
    };
  }
  if (availability.modelAvailable) {
    return {
      state: "ready",
      label: "Ready",
      detail: `${name} is connected and available.`,
    };
  }
  return {
    state: "unavailable",
    label: "Unavailable",
    detail:
      availability.status === "temporarily_unavailable"
        ? `${name} is temporarily unavailable. Try again shortly.`
        : `${name} is connected, but execution is not available in this workspace.`,
  };
}

function toolReadiness(
  tool: Awaited<ReturnType<typeof loadToolCatalogForProviders>>[number],
  status: UserMcpProviderStatus | undefined,
): CommandPaletteReadiness {
  const provider = providerReadiness(tool.provider, status);
  if (provider.state !== "ready") return provider;
  const policy = status?.toolPolicies?.[tool.provider];
  if (!tool.enabled || policy?.blockedTools?.includes(tool.toolName)) {
    return {
      state: "policy_blocked",
      label: "Blocked",
      detail:
        "This tool is disabled by workspace policy. Ask an admin to enable it.",
    };
  }
  if (policy?.allowedTools && !policy.allowedTools.includes(tool.toolName)) {
    return {
      state: "approval_required",
      label: "Needs approval",
      detail:
        "This tool needs workspace approval before Comparative can use it.",
    };
  }
  return {
    state: "ready",
    label: "Ready",
    detail: `${providerLabel(tool.provider)} can use this tool.`,
  };
}

function providerLabel(provider: string): string {
  return (
    INTEGRATION_DISPLAY_NAMES[
      provider as keyof typeof INTEGRATION_DISPLAY_NAMES
    ] ?? humanize(provider)
  );
}

function humanize(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function truncate(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max
    ? normalized
    : `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
