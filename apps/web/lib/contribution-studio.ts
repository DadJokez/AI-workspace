import type { AssistantSource } from "@ai-workspace/agent/sources";
import type { UiMessage } from "@/app/chat/chat-client-state";
import {
  buildToolActivityEvents,
  type ActivityCategory,
  type AgentActivityEvent,
} from "@/lib/activity-events";
import {
  groupActivityEvents,
  inferCategory,
  type ActivityReceipt,
} from "@/lib/activity-receipts";
import type { WorkspaceArtifactSummary } from "@/lib/workspace-artifacts";
import type { StudioBrowserTargetRequest } from "@/lib/studio-browser-contract";
import type { GuardrailReceipt } from "@/lib/guardrail-receipts";

export const CONTRIBUTION_STUDIO_TABS = [
  "preview",
  "files",
  "browser",
  "activity",
  "console",
] as const;

export type ContributionStudioTab =
  (typeof CONTRIBUTION_STUDIO_TABS)[number];
export type ContributionStudioScope = "thread" | "workspace";
export type StudioWorkState =
  | "planned"
  | "active"
  | "waiting"
  | "completed"
  | "failed"
  | "canceled";

export interface StudioCapabilities {
  /** Browser is deny-by-default until the AgentCore runtime is provisioned. */
  browser?: boolean;
  /** Console is deny-by-default and only appears for a task-owned sandbox. */
  console?: boolean;
}

export interface StudioFileResource {
  id: string;
  title: string;
  filename: string;
  kind: string;
  source: string;
  sizeBytes?: number;
  createdAt?: string;
  artifact?: WorkspaceArtifactSummary;
}

export interface StudioBrowserEvidence {
  id: string;
  messageId: string;
  sourceNumber: number;
  title: string;
  kind: AssistantSource["kind"];
  url?: string;
  toolCallId?: string;
}

export interface StudioBrowserResource {
  id: string;
  title: string;
  detail: string;
  kind: "web" | "repo" | "artifact" | "app" | "sandbox";
  displayUrl?: string;
  target: StudioBrowserTargetRequest;
}

export interface StudioWorkStep {
  id: string;
  label: string;
  state: StudioWorkState;
  category: ActivityCategory;
  eventCount: number;
  startedAt?: string;
  completedAt?: string;
  elapsedMs?: number;
  runId?: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
  evidence: StudioBrowserEvidence[];
  lowLevel: boolean;
}

export interface ContributionStudioModel {
  tabs: ContributionStudioTab[];
  files: StudioFileResource[];
  browserEvidence: StudioBrowserEvidence[];
  browserResources: StudioBrowserResource[];
  workSteps: StudioWorkStep[];
  guardrails: GuardrailReceipt[];
  previewArtifact?: WorkspaceArtifactSummary;
  working: boolean;
}

interface DeriveContributionStudioOptions {
  artifact?: WorkspaceArtifactSummary;
  scope?: ContributionStudioScope;
  capabilities?: StudioCapabilities;
}

/**
 * Build the user-visible Studio from persisted, structured message data only.
 * Provider reasoning, raw prompts, and tool payloads are intentionally absent.
 */
export function deriveContributionStudio(
  messages: readonly UiMessage[],
  options: DeriveContributionStudioOptions = {},
): ContributionStudioModel {
  const files = collectStudioFiles(messages, options.artifact);
  const browserEvidence = collectBrowserEvidence(messages);
  const browserResources = collectBrowserResources(
    messages,
    files,
    browserEvidence,
  );
  const workSteps = collectWorkSteps(messages, browserEvidence);
  const guardrails = collectGuardrailReceipts(messages);
  const previewArtifact =
    options.artifact ?? files.find((file) => file.artifact)?.artifact;
  const tabs: ContributionStudioTab[] = [];

  if (previewArtifact) tabs.push("preview");
  if (options.scope === "workspace" || files.length > 0) tabs.push("files");
  if (options.capabilities?.browser === true && browserResources.length > 0) {
    tabs.push("browser");
  }
  if (workSteps.length > 0 || guardrails.length > 0) tabs.push("activity");
  if (options.capabilities?.console === true) tabs.push("console");

  return {
    tabs,
    files,
    browserEvidence,
    browserResources,
    workSteps,
    guardrails,
    previewArtifact,
    working: messages.some(
      (message) =>
        message.pending === true ||
        message.canCancel === true ||
        message.activityEvents?.some((event) => event.state === "pending") ===
          true ||
        /^(queued|running|pending|leased|cancel_requested)$/i.test(
          message.runStatus ?? "",
        ),
    ),
  };
}

function collectGuardrailReceipts(
  messages: readonly UiMessage[],
): GuardrailReceipt[] {
  const receipts = new Map<string, GuardrailReceipt>();
  for (const message of messages) {
    if (message.guardrails) {
      receipts.set(message.guardrails.runId, message.guardrails);
    }
  }
  return [...receipts.values()];
}

export function resolveContributionStudioTab({
  available,
  requested,
  remembered,
  scope = "thread",
  artifact,
  working = false,
}: {
  available: readonly ContributionStudioTab[];
  requested?: ContributionStudioTab;
  remembered?: ContributionStudioTab | null;
  scope?: ContributionStudioScope;
  artifact?: WorkspaceArtifactSummary;
  working?: boolean;
}): ContributionStudioTab | null {
  if (available.length === 0) return null;
  if (requested && available.includes(requested)) return requested;
  if (artifact && available.includes("preview")) return "preview";
  if (scope === "workspace" && available.includes("files")) return "files";
  if (working && available.includes("activity")) return "activity";
  if (remembered && available.includes(remembered)) return remembered;
  return available[0] ?? null;
}

export function isContributionStudioTab(
  value: string | null | undefined,
): value is ContributionStudioTab {
  return CONTRIBUTION_STUDIO_TABS.includes(value as ContributionStudioTab);
}

export function isSafeBrowserEvidenceUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function collectStudioFiles(
  messages: readonly UiMessage[],
  selectedArtifact?: WorkspaceArtifactSummary,
): StudioFileResource[] {
  const files = new Map<string, StudioFileResource>();

  const addArtifact = (artifact: WorkspaceArtifactSummary) => {
    files.set(artifact.id, {
      id: artifact.id,
      title: artifact.title,
      filename: artifact.filename,
      kind: artifact.kind,
      source: artifact.source,
      sizeBytes: artifact.sizeBytes,
      createdAt: artifact.createdAt,
      artifact,
    });
  };

  if (selectedArtifact) addArtifact(selectedArtifact);
  for (const message of messages) {
    for (const artifact of message.artifacts ?? []) addArtifact(artifact);
    for (const [index, attachment] of (message.attachmentPreviews ?? []).entries()) {
      const id = `pending:${message.id}:${index}:${attachment.name}`;
      if ([...files.values()].some((file) => file.filename === attachment.name)) {
        continue;
      }
      files.set(id, {
        id,
        title: attachment.name,
        filename: attachment.name,
        kind: fileExtension(attachment.name) || "file",
        source: "pending-upload",
        sizeBytes: attachment.sizeBytes,
        createdAt: message.createdAt,
      });
    }
  }

  return [...files.values()].sort((left, right) =>
    (right.createdAt ?? "").localeCompare(left.createdAt ?? ""),
  );
}

function collectBrowserEvidence(
  messages: readonly UiMessage[],
): StudioBrowserEvidence[] {
  const evidence = new Map<string, StudioBrowserEvidence>();
  for (const message of messages) {
    for (const source of message.sources ?? []) {
      if (source.kind !== "web" && source.kind !== "repo") continue;
      const safeUrl = isSafeBrowserEvidenceUrl(source.url)
        ? source.url
        : undefined;
      const key = safeUrl ?? `${source.kind}:${source.title}:${source.toolCallId ?? source.n}`;
      if (evidence.has(key)) continue;
      evidence.set(key, {
        id: key,
        messageId: message.id,
        sourceNumber: source.n,
        title: source.title,
        kind: source.kind,
        ...(safeUrl ? { url: safeUrl } : {}),
        ...(source.toolCallId ? { toolCallId: source.toolCallId } : {}),
      });
    }
  }
  return [...evidence.values()];
}

function collectBrowserResources(
  messages: readonly UiMessage[],
  files: readonly StudioFileResource[],
  evidence: readonly StudioBrowserEvidence[],
): StudioBrowserResource[] {
  const resources = new Map<string, StudioBrowserResource>();

  for (const item of evidence) {
    if (!item.url) continue;
    resources.set(item.id, {
      id: item.id,
      title: item.title,
      detail: item.kind === "repo" ? "Repository evidence" : "Web evidence",
      kind: item.kind === "repo" ? "repo" : "web",
      displayUrl: item.url,
      target: {
        kind: "evidence",
        messageId: item.messageId,
        sourceNumber: item.sourceNumber,
      },
    });
  }

  for (const file of files) {
    if (!file.artifact) continue;
    resources.set(`artifact:${file.artifact.id}`, {
      id: `artifact:${file.artifact.id}`,
      title: file.filename,
      detail: `Artifact v${file.artifact.versionNumber}`,
      kind: "artifact",
      displayUrl: `comparative://artifact/${file.filename}`,
      target: { kind: "artifact", artifactId: file.artifact.id },
    });
  }

  const latestApps = new Map<string, NonNullable<UiMessage["appDraftVersions"]>[number]>();
  for (const message of messages) {
    for (const version of message.appDraftVersions ?? []) {
      const current = latestApps.get(version.appId);
      if (!current || version.versionNumber > current.versionNumber) {
        latestApps.set(version.appId, version);
      }
    }
  }
  for (const version of latestApps.values()) {
    resources.set(`app:${version.id}`, {
      id: `app:${version.id}`,
      title: version.appName,
      detail: `App v${version.versionNumber}`,
      kind: "app",
      displayUrl: `comparative://app/${version.appSlug}`,
      target: { kind: "app", appVersionId: version.id },
    });
  }

  return [...resources.values()];
}

function collectWorkSteps(
  messages: readonly UiMessage[],
  evidence: readonly StudioBrowserEvidence[],
): StudioWorkStep[] {
  const steps: StudioWorkStep[] = [];

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const events = activityEventsForMessage(message);
    const receipts = groupAdjacentActivity(events);

    for (const receipt of receipts) {
      const state = workStateForEvents(receipt.events);
      const startedAt = firstTimestamp(receipt.events) ?? message.createdAt;
      const completedAt = isTerminalWorkState(state)
        ? lastTimestamp(receipt.events) ?? message.createdAt
        : undefined;
      const eventIds = new Set(receipt.events.map((event) => event.id));
      steps.push({
        id: `${message.id}:${receipt.id}`,
        label: receipt.label,
        state,
        category: receipt.category,
        eventCount: receipt.events.length,
        ...(startedAt ? { startedAt } : {}),
        ...(completedAt ? { completedAt } : {}),
        ...elapsedFields(startedAt, completedAt),
        ...(message.runId ? { runId: message.runId } : {}),
        tokensIn: message.tokensIn,
        tokensOut: message.tokensOut,
        evidence: evidence.filter(
          (item) => item.toolCallId && eventIds.has(item.toolCallId),
        ),
        lowLevel:
          receipt.events.length > 1 ||
          receipt.category === "progress" ||
          receipt.category === "workspace",
      });
    }

    if (message.artifacts?.length && !hasDeliverableReceipt(events)) {
      const createdAt = latestArtifactTimestamp(message.artifacts) ?? message.createdAt;
      steps.push({
        id: `${message.id}:deliverables`,
        label: deliverableLabel(message.artifacts),
        state: "completed",
        category: "workspace",
        eventCount: message.artifacts.length,
        ...(createdAt ? { startedAt: createdAt, completedAt: createdAt } : {}),
        ...(message.runId ? { runId: message.runId } : {}),
        tokensIn: message.tokensIn,
        tokensOut: message.tokensOut,
        evidence: [],
        lowLevel: false,
      });
    }

    if (receipts.length === 0 && !message.artifacts?.length) {
      const state = workStateForMessage(message);
      if (!state) continue;
      steps.push({
        id: `${message.id}:response`,
        label: directResponseLabel(state),
        state,
        category: "progress",
        eventCount: 1,
        ...(message.createdAt ? { startedAt: message.createdAt } : {}),
        ...(message.createdAt && isTerminalWorkState(state)
          ? { completedAt: message.createdAt }
          : {}),
        ...(message.runId ? { runId: message.runId } : {}),
        tokensIn: message.tokensIn,
        tokensOut: message.tokensOut,
        evidence: [],
        lowLevel: true,
      });
    }
  }

  return steps;
}

function activityEventsForMessage(message: UiMessage): AgentActivityEvent[] {
  if (message.activityEvents?.length) return message.activityEvents;
  return buildToolActivityEvents(message.toolCalls, message.toolResults);
}

function groupAdjacentActivity(
  events: readonly AgentActivityEvent[],
): ActivityReceipt[] {
  const groups: AgentActivityEvent[][] = [];
  for (const event of events) {
    const current = groups.at(-1);
    const previous = current?.at(-1);
    const sameCategory =
      previous &&
      (previous.category ?? inferCategory(previous.label)) ===
        (event.category ?? inferCategory(event.label));
    const sameState =
      previous &&
      workStateForEvents([previous]) === workStateForEvents([event]);
    if (current && sameCategory && sameState) current.push(event);
    else groups.push([event]);
  }

  return groups.flatMap((group, index) =>
    groupActivityEvents(group).map((receipt) => ({
      ...receipt,
      id: `${receipt.id}-${index}`,
    })),
  );
}

function workStateForEvents(
  events: readonly AgentActivityEvent[],
): StudioWorkState {
  if (events.some((event) => event.state === "failed")) return "failed";
  if (events.some(isCanonicalCanceledEvent)) return "canceled";
  const pendingEvents = events.filter((event) => event.state === "pending");
  if (pendingEvents.some(isCanonicalWaitingEvent)) {
    return "waiting";
  }
  if (pendingEvents.some(isCanonicalPlannedEvent)) {
    return "planned";
  }
  if (pendingEvents.length > 0) return "active";
  return "completed";
}

function workStateForMessage(message: UiMessage): StudioWorkState | null {
  const runStatus = message.runStatus?.trim().toLowerCase();
  const status = message.status?.trim().toLowerCase();
  if (runStatus === "canceled") return "canceled";
  if (runStatus === "failed" || message.runError) return "failed";
  if (status && CANONICAL_WAITING_LABELS.has(status)) {
    return "waiting";
  }
  if (runStatus === "queued") return "planned";
  if (
    message.pending ||
    message.canCancel ||
    runStatus === "running" ||
    ACTIVE_LIVE_PHASES.has(message.livePhase?.trim().toLowerCase() ?? "")
  ) {
    return "active";
  }
  if (message.content || runStatus === "succeeded") {
    return "completed";
  }
  return null;
}

const CANONICAL_WAITING_LABELS = new Set([
  "awaiting approval",
  "needs your input",
  "paused",
  "waiting for approval",
  "waiting for your input",
]);

const ACTIVE_LIVE_PHASES = new Set(["finalizing", "planning", "using tools"]);

function normalizedActivityLabel(event: AgentActivityEvent): string {
  return event.label.trim().toLowerCase();
}

function isCanonicalCanceledEvent(event: AgentActivityEvent): boolean {
  return (
    event.category === "progress" &&
    normalizedActivityLabel(event) === "run canceled"
  );
}

function isCanonicalWaitingEvent(event: AgentActivityEvent): boolean {
  return CANONICAL_WAITING_LABELS.has(normalizedActivityLabel(event));
}

function isCanonicalPlannedEvent(event: AgentActivityEvent): boolean {
  if (event.category !== "progress") return false;
  return /^(?:planned|queued|scheduled)(?:\s|$)/.test(
    normalizedActivityLabel(event),
  );
}

function directResponseLabel(state: StudioWorkState): string {
  if (state === "active") return "Preparing response";
  if (state === "planned") return "Response queued";
  if (state === "waiting") return "Waiting for your input";
  if (state === "failed") return "Response failed";
  if (state === "canceled") return "Run canceled";
  return "Prepared response";
}

function isTerminalWorkState(state: StudioWorkState): boolean {
  return state === "completed" || state === "failed" || state === "canceled";
}

function firstTimestamp(events: readonly AgentActivityEvent[]): string | undefined {
  return events.find((event) => event.at)?.at;
}

function lastTimestamp(events: readonly AgentActivityEvent[]): string | undefined {
  return [...events].reverse().find((event) => event.at)?.at;
}

function elapsedFields(startedAt?: string, completedAt?: string) {
  if (!startedAt || !completedAt) return {};
  const elapsedMs =
    new Date(completedAt).getTime() - new Date(startedAt).getTime();
  return Number.isFinite(elapsedMs) && elapsedMs >= 0 ? { elapsedMs } : {};
}

function hasDeliverableReceipt(events: readonly AgentActivityEvent[]): boolean {
  return events.some((event) =>
    /created|edited|updated|published|uploaded|saved/.test(
      event.label.toLowerCase(),
    ),
  );
}

function latestArtifactTimestamp(
  artifacts: readonly WorkspaceArtifactSummary[],
): string | undefined {
  return [...artifacts]
    .map((artifact) => artifact.createdAt)
    .sort()
    .at(-1);
}

function deliverableLabel(artifacts: readonly WorkspaceArtifactSummary[]): string {
  if (artifacts.length === 1) return `Created ${artifacts[0]!.filename}`;
  return `Created ${artifacts.length} files`;
}

function fileExtension(filename: string): string {
  return filename.split(".").at(-1)?.toLowerCase() ?? "";
}
