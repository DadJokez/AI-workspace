import type { SessionUser } from "@ai-workspace/auth";
import {
  apps,
  type App,
  type Database,
  schedules,
  skills,
  type Skill,
} from "@ai-workspace/db";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { listAppsSharedWith } from "@/lib/apps";
import {
  loadUserMcpProviderStatus,
  type UserMcpProviderStatus,
} from "@/lib/oauth/mcp-servers";
import { listSkillsSharedWith } from "@/lib/shares";

export type CapabilityKind = "provider" | "skill" | "app" | "schedule";
export type CapabilitySource = "connected" | "owned" | "starter" | "shared";

export interface CapabilityEntry {
  id: string;
  kind: CapabilityKind;
  name: string;
  source: CapabilitySource;
  runnableNow: boolean;
  needsApproval: boolean;
  requiresProviders: string[];
  readyProviders: string[];
  missingProviders: string[];
  pendingApprovalProviders: string[];
  mountedNow?: boolean;
  status: string;
  why: string;
  metadata?: Record<string, unknown>;
}

export interface CapabilityGraph {
  userId: string;
  generatedAt: string;
  providers: CapabilityEntry[];
  skills: CapabilityEntry[];
  apps: CapabilityEntry[];
  schedules: CapabilityEntry[];
}

export interface SkillCapabilityInput {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  ownerUserId: string;
  isStarter: boolean;
  mcpProviders: string[];
  sharedWithMe?: boolean;
}

export interface AppCapabilityInput {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  ownerUserId: string;
  status: string;
  liveArtifactId?: string | null;
  sharedWithMe?: boolean;
}

export interface ScheduleCapabilityInput {
  id: string;
  skillId: string;
  skillName?: string | null;
  cadence: string;
  timezone: string;
  enabled: boolean;
  nextRunAt: Date | string;
  lastError?: string | null;
}

export interface BuildCapabilityGraphInput {
  userId: string;
  providerStatus: UserMcpProviderStatus;
  mountedProviders?: readonly string[];
  skills?: readonly SkillCapabilityInput[];
  apps?: readonly AppCapabilityInput[];
  schedules?: readonly ScheduleCapabilityInput[];
  now?: Date;
}

export async function loadUserCapabilityGraph(
  db: Database,
  user: Pick<SessionUser, "id" | "role">,
  options: { mountedProviders?: readonly string[] } = {},
): Promise<CapabilityGraph> {
  const [providerStatus, skillRows, sharedSkills, appRows, sharedApps, scheduleRows] =
    await Promise.all([
      loadUserMcpProviderStatus(db, user.id),
      db
        .select()
        .from(skills)
        .where(
          and(
            isNull(skills.archivedAt),
            or(eq(skills.ownerUserId, user.id), eq(skills.isStarter, true)),
          ),
        )
        .orderBy(desc(skills.updatedAt)),
      listSkillsSharedWith(db, user.id),
      db
        .select()
        .from(apps)
        .where(and(eq(apps.ownerUserId, user.id), isNull(apps.archivedAt)))
        .orderBy(desc(apps.updatedAt)),
      listAppsSharedWith(db, user.id),
      db
        .select({
          id: schedules.id,
          skillId: schedules.skillId,
          skillName: skills.name,
          cadence: schedules.cadence,
          timezone: schedules.timezone,
          enabled: schedules.enabled,
          nextRunAt: schedules.nextRunAt,
          lastError: schedules.lastError,
        })
        .from(schedules)
        .leftJoin(skills, eq(schedules.skillId, skills.id))
        .where(eq(schedules.userId, user.id))
        .orderBy(desc(schedules.createdAt)),
    ]);

  return buildCapabilityGraph({
    userId: user.id,
    providerStatus,
    mountedProviders: options.mountedProviders,
    skills: mergeSharedSkills(skillRows, sharedSkills, user.id),
    apps: mergeSharedApps(appRows, sharedApps, user.id),
    schedules: scheduleRows,
  });
}

export function buildCapabilityGraph({
  userId,
  providerStatus,
  mountedProviders = [],
  skills = [],
  apps = [],
  schedules = [],
  now = new Date(),
}: BuildCapabilityGraphInput): CapabilityGraph {
  const connected = unique(providerStatus.connectedProviders);
  const approved = unique(providerStatus.allowedProviders);
  const pending = unique(providerStatus.deniedProviders);
  const mounted = new Set(mountedProviders);

  return {
    userId,
    generatedAt: now.toISOString(),
    providers: connected.map((provider) => {
      const isApproved = approved.includes(provider);
      const needsApproval = pending.includes(provider) || !isApproved;
      return {
        id: `provider:${provider}`,
        kind: "provider",
        name: label(provider),
        source: "connected",
        runnableNow: isApproved,
        needsApproval,
        requiresProviders: [],
        readyProviders: isApproved ? [provider] : [],
        missingProviders: [],
        pendingApprovalProviders: needsApproval ? [provider] : [],
        mountedNow: mounted.has(provider),
        status: isApproved ? "approved" : "pending_approval",
        why: isApproved
          ? `${label(provider)} is connected and approved for this user.`
          : `${label(provider)} is connected but pending approval for this user.`,
        metadata: { provider },
      } satisfies CapabilityEntry;
    }),
    skills: skills.map((skill) =>
      buildSkillCapability(skill, userId, connected, approved, pending),
    ),
    apps: apps.map((app) => buildAppCapability(app, userId)),
    schedules: schedules.map(buildScheduleCapability),
  };
}

export function renderCapabilitySummaryForPrompt(
  graph: CapabilityGraph,
  limitPerKind = 8,
): string {
  return [
    "Capability graph summary for this user:",
    renderEntries("Tools", graph.providers, limitPerKind),
    renderEntries("Skills", graph.skills, limitPerKind),
    renderEntries("Apps", graph.apps, limitPerKind),
    renderEntries("Schedules", graph.schedules, limitPerKind),
    "Use this to answer capability questions and to recommend existing tools, skills, apps, or schedules before rebuilding something manually.",
  ].join("\n");
}

function buildSkillCapability(
  skill: SkillCapabilityInput,
  userId: string,
  connectedProviders: readonly string[],
  approvedProviders: readonly string[],
  pendingProviders: readonly string[],
): CapabilityEntry {
  const required = unique(skill.mcpProviders);
  const readyProviders = required.filter((provider) =>
    approvedProviders.includes(provider),
  );
  const missingProviders = required.filter(
    (provider) => !connectedProviders.includes(provider),
  );
  const pendingApprovalProviders = required.filter(
    (provider) =>
      connectedProviders.includes(provider) &&
      (pendingProviders.includes(provider) || !approvedProviders.includes(provider)),
  );
  const source = skill.sharedWithMe
    ? "shared"
    : skill.ownerUserId === userId
      ? "owned"
      : "starter";
  const runnableNow =
    missingProviders.length === 0 && pendingApprovalProviders.length === 0;
  return {
    id: `skill:${skill.id}`,
    kind: "skill",
    name: skill.name,
    source,
    runnableNow,
    needsApproval: pendingApprovalProviders.length > 0,
    requiresProviders: required,
    readyProviders,
    missingProviders,
    pendingApprovalProviders,
    status: runnableNow ? "ready" : "needs_provider",
    why: skillWhy(skill, source, missingProviders, pendingApprovalProviders),
    metadata: {
      skillId: skill.id,
      slug: skill.slug,
      description: skill.description ?? null,
    },
  };
}

function buildAppCapability(
  app: AppCapabilityInput,
  userId: string,
): CapabilityEntry {
  const source = app.sharedWithMe
    ? "shared"
    : app.ownerUserId === userId
      ? "owned"
      : "shared";
  const runnableNow = app.status === "deployed" && Boolean(app.liveArtifactId);
  return {
    id: `app:${app.id}`,
    kind: "app",
    name: app.name,
    source,
    runnableNow,
    needsApproval: false,
    requiresProviders: [],
    readyProviders: [],
    missingProviders: [],
    pendingApprovalProviders: [],
    status: runnableNow ? "deployed" : app.status,
    why: runnableNow
      ? `${app.name} is a deployed ${source} app and can be opened now.`
      : `${app.name} exists as a ${source} app but is not deployed yet.`,
    metadata: {
      appId: app.id,
      slug: app.slug,
      description: app.description ?? null,
      liveArtifactId: app.liveArtifactId ?? null,
    },
  };
}

function buildScheduleCapability(
  schedule: ScheduleCapabilityInput,
): CapabilityEntry {
  return {
    id: `schedule:${schedule.id}`,
    kind: "schedule",
    name: schedule.skillName
      ? `${schedule.skillName} schedule`
      : `Schedule ${schedule.id}`,
    source: "owned",
    runnableNow: schedule.enabled,
    needsApproval: false,
    requiresProviders: [],
    readyProviders: [],
    missingProviders: [],
    pendingApprovalProviders: [],
    status: schedule.enabled ? "enabled" : "disabled",
    why: schedule.enabled
      ? `Runs ${schedule.cadence} in ${schedule.timezone}; next run ${formatDate(schedule.nextRunAt)}.`
      : `Schedule exists but is disabled.`,
    metadata: {
      scheduleId: schedule.id,
      skillId: schedule.skillId,
      cadence: schedule.cadence,
      timezone: schedule.timezone,
      nextRunAt: formatDate(schedule.nextRunAt),
      lastError: schedule.lastError ?? null,
    },
  };
}

function renderEntries(
  labelText: string,
  entries: readonly CapabilityEntry[],
  limit: number,
): string {
  if (entries.length === 0) return `- ${labelText}: none.`;
  const shown = entries.slice(0, limit).map((entry) => {
    const providerState =
      entry.requiresProviders.length > 0
        ? ` Requires ${formatList(entry.requiresProviders)}.`
        : "";
    const mountedState =
      entry.kind === "provider" && entry.mountedNow === false
        ? " Not mounted on this turn."
        : "";
    return `${entry.name} (${entry.status}; ${entry.runnableNow ? "runnable now" : "not runnable now"}). ${entry.why}${providerState}${mountedState}`;
  });
  const suffix =
    entries.length > limit ? ` (+${entries.length - limit} more)` : "";
  return `- ${labelText}: ${shown.join(" ")}${suffix}`;
}

function skillWhy(
  skill: SkillCapabilityInput,
  source: CapabilitySource,
  missingProviders: readonly string[],
  pendingApprovalProviders: readonly string[],
): string {
  if (missingProviders.length > 0) {
    return `${skill.name} is ${source}, but needs ${formatList(
      missingProviders,
    )} connected before it can run fully.`;
  }
  if (pendingApprovalProviders.length > 0) {
    return `${skill.name} is ${source}, but ${formatList(
      pendingApprovalProviders,
    )} is pending approval.`;
  }
  return `${skill.name} is ${source} and can run now.`;
}

function mergeSharedSkills(
  primary: readonly Skill[],
  shared: readonly Skill[],
  userId: string,
): SkillCapabilityInput[] {
  const seen = new Set<string>();
  const out: SkillCapabilityInput[] = [];
  for (const skill of primary) {
    seen.add(skill.id);
    out.push({ ...skill, sharedWithMe: false });
  }
  for (const skill of shared) {
    if (seen.has(skill.id)) continue;
    out.push({ ...skill, sharedWithMe: skill.ownerUserId !== userId });
  }
  return out;
}

function mergeSharedApps(
  primary: readonly App[],
  shared: readonly App[],
  userId: string,
): AppCapabilityInput[] {
  const seen = new Set<string>();
  const out: AppCapabilityInput[] = [];
  for (const app of primary) {
    seen.add(app.id);
    out.push({ ...app, sharedWithMe: false });
  }
  for (const app of shared) {
    if (seen.has(app.id)) continue;
    out.push({ ...app, sharedWithMe: app.ownerUserId !== userId });
  }
  return out;
}

function formatDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function formatList(values: readonly string[]): string {
  return values.length > 0 ? values.map(label).join(", ") : "none";
}

function label(value: string): string {
  if (value.toLowerCase() === "github") return "GitHub";
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}
