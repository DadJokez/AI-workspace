export type RecommendationType =
  | "tool"
  | "save_as_skill"
  | "run_existing_skill"
  | "open_existing_app"
  | "deploy_artifact_as_app"
  | "schedule_skill";

export interface RecommendationCandidate {
  id: string;
  type: RecommendationType;
  title: string;
  reason: string;
  requiresApproval: boolean;
  action:
    | { kind: "connect_tool"; provider: string }
    | { kind: "run_skill"; skillId: string }
    | { kind: "open_app"; appId: string; slug?: string }
    | { kind: "create_skill"; source: "repeated_workflow" }
    | { kind: "deploy_app"; artifactId: string }
    | { kind: "create_schedule"; skillId?: string; cadenceHint: string };
  metadata?: Record<string, unknown>;
}

export type RecommendationStatus = "suggested" | "accepted" | "dismissed";

export interface PersistedRecommendation extends RecommendationCandidate {
  dbId: string;
  status: RecommendationStatus;
  threadId: string | null;
  chatMessageId: string | null;
  runId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecommendationSkill {
  id: string;
  name: string;
  description?: string | null;
  mcpProviders?: readonly string[];
  runnableNow?: boolean;
  sharedWithMe?: boolean;
}

export interface RecommendationArtifact {
  id: string;
  title: string;
  filename: string;
  kind: string;
  mimeType?: string | null;
}

export interface RecommendationApp {
  id: string;
  name: string;
  description?: string | null;
  slug?: string | null;
  runnableNow?: boolean;
  sharedWithMe?: boolean;
}

export interface BuildRecommendationCandidatesInput {
  currentMessage: string;
  recentUserMessages?: readonly string[];
  roleContext?: string | null;
  connectedProviders?: readonly string[];
  approvedProviders?: readonly string[];
  skills?: readonly RecommendationSkill[];
  apps?: readonly RecommendationApp[];
  artifacts?: readonly RecommendationArtifact[];
}

const WORKFLOW_VERBS = new Set([
  "draft",
  "write",
  "summarize",
  "review",
  "triage",
  "brief",
  "prepare",
  "update",
  "report",
  "analyze",
  "check",
]);

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "into",
  "again",
  "please",
  "can",
  "you",
  "make",
  "give",
  "show",
  "need",
  "what",
  "which",
  "should",
]);

export function buildRecommendationCandidates({
  currentMessage,
  recentUserMessages = [],
  roleContext,
  connectedProviders = [],
  approvedProviders = connectedProviders,
  skills = [],
  apps = [],
  artifacts = [],
}: BuildRecommendationCandidatesInput): RecommendationCandidate[] {
  const candidates: RecommendationCandidate[] = [];
  const normalized = normalize(currentMessage);
  const currentTokens = significantTokens(currentMessage);
  const approved = new Set(approvedProviders.map((p) => p.toLowerCase()));
  const connected = new Set(connectedProviders.map((p) => p.toLowerCase()));

  const repeatedCount = countSimilarWorkflow(
    currentTokens,
    recentUserMessages,
  );
  if (repeatedCount >= 2 && hasWorkflowVerb(currentTokens)) {
    candidates.push({
      id: "save-as-skill:repeated-workflow",
      type: "save_as_skill",
      title: "Save this as a skill",
      reason: `You have asked for this kind of workflow ${repeatedCount} times recently.`,
      requiresApproval: true,
      action: { kind: "create_skill", source: "repeated_workflow" },
      metadata: { repeatedCount },
    });
  }

  const matchingSkill = bestMatchingSkill({
    message: currentMessage,
    roleContext,
    skills,
    approvedProviders: approved,
  });
  if (matchingSkill) {
    const providers = unique(
      (matchingSkill.mcpProviders ?? []).map((p) => p.toLowerCase()),
    );
    candidates.push({
      id: `run-skill:${matchingSkill.id}`,
      type: "run_existing_skill",
      title: `Run ${matchingSkill.name}`,
      reason:
        providers.length > 0
          ? `${matchingSkill.name} matches this request and can use your connected ${formatList(
              providers,
            )} tool access.`
          : `${matchingSkill.name} matches this request and can run without extra tools.`,
      requiresApproval: true,
      action: { kind: "run_skill", skillId: matchingSkill.id },
      metadata: {
        skillId: matchingSkill.id,
        sharedWithMe: matchingSkill.sharedWithMe === true,
        providers,
      },
    });
  }

  const matchingApp = bestMatchingApp({
    message: currentMessage,
    roleContext,
    apps,
  });
  if (matchingApp) {
    candidates.push({
      id: `open-app:${matchingApp.id}`,
      type: "open_existing_app",
      title: `Open ${matchingApp.name}`,
      reason: matchingApp.sharedWithMe
        ? `${matchingApp.name} is shared with you and matches this request.`
        : `${matchingApp.name} already exists in your workspace and matches this request.`,
      requiresApproval: false,
      action: {
        kind: "open_app",
        appId: matchingApp.id,
        ...(matchingApp.slug ? { slug: matchingApp.slug } : {}),
      },
      metadata: {
        appId: matchingApp.id,
        slug: matchingApp.slug ?? null,
        sharedWithMe: matchingApp.sharedWithMe === true,
      },
    });
  }

  const appArtifact = artifacts.find(isReusableAppArtifact);
  if (
    appArtifact &&
    hasReusableArtifactIntent(normalized) &&
    (!matchingApp || !appMatchesArtifact(matchingApp, appArtifact))
  ) {
    candidates.push({
      id: `deploy-app:${appArtifact.id}`,
      type: "deploy_artifact_as_app",
      title: "Deploy this as an app",
      reason: `${appArtifact.title} looks reusable, so it can become an app you can open and update later.`,
      requiresApproval: true,
      action: { kind: "deploy_app", artifactId: appArtifact.id },
      metadata: { artifactId: appArtifact.id, filename: appArtifact.filename },
    });
  }

  const cadenceHint = cadenceFromMessage(normalized);
  if (cadenceHint) {
    candidates.push({
      id: matchingSkill
        ? `schedule-skill:${matchingSkill.id}:${cadenceHint}`
        : `schedule-skill:new:${cadenceHint}`,
      type: "schedule_skill",
      title: "Schedule this workflow",
      reason: `You mentioned a recurring cadence (${cadenceHint}); scheduling should be offered only after you approve it.`,
      requiresApproval: true,
      action: {
        kind: "create_schedule",
        ...(matchingSkill ? { skillId: matchingSkill.id } : {}),
        cadenceHint,
      },
    });
  }

  const provider = providerMention(normalized);
  if (provider && connected.has(provider) && !matchingSkill) {
    candidates.push({
      id: `tool:${provider}`,
      type: "tool",
      title: `Use ${label(provider)}`,
      reason: `${label(provider)} is connected, so Comparative can check it directly instead of asking you to paste results.`,
      requiresApproval: false,
      action: { kind: "connect_tool", provider },
      metadata: { provider },
    });
  }

  return dedupeCandidates(candidates);
}

function bestMatchingSkill({
  message,
  roleContext,
  skills,
  approvedProviders,
}: {
  message: string;
  roleContext?: string | null;
  skills: readonly RecommendationSkill[];
  approvedProviders: Set<string>;
}): RecommendationSkill | null {
  const queryTokens = new Set([
    ...significantTokens(message),
    ...significantTokens(roleContext ?? ""),
  ]);
  let best: { skill: RecommendationSkill; score: number } | null = null;

  for (const skill of skills) {
    if (skill.runnableNow === false) continue;
    const providers = unique(
      (skill.mcpProviders ?? []).map((p) => p.toLowerCase()),
    );
    if (providers.some((provider) => !approvedProviders.has(provider))) continue;

    const skillTokens = significantTokens(
      `${skill.name} ${skill.description ?? ""}`,
    );
    const overlap = skillTokens.filter((token) => queryTokens.has(token));
    const score = overlap.length + providerIntentBoost(message, providers);
    if (score > 0 && (!best || score > best.score)) {
      best = { skill, score };
    }
  }

  return best?.skill ?? null;
}

function bestMatchingApp({
  message,
  roleContext,
  apps,
}: {
  message: string;
  roleContext?: string | null;
  apps: readonly RecommendationApp[];
}): RecommendationApp | null {
  const queryTokens = new Set([
    ...significantTokens(message),
    ...significantTokens(roleContext ?? ""),
  ]);
  let best: { app: RecommendationApp; score: number } | null = null;

  for (const app of apps) {
    if (app.runnableNow === false) continue;
    const appTokens = significantTokens(`${app.name} ${app.description ?? ""}`);
    const overlap = appTokens.filter((token) => queryTokens.has(token));
    if (overlap.length === 0) continue;

    const score = overlap.length + appIntentBoost(message);
    if (!best || score > best.score) {
      best = { app, score };
    }
  }

  return best?.app ?? null;
}

function countSimilarWorkflow(
  currentTokens: readonly string[],
  recentUserMessages: readonly string[],
): number {
  if (currentTokens.length < 3) return 0;
  let count = 1;
  for (const message of recentUserMessages) {
    const tokens = significantTokens(message);
    if (tokens.length < 3) continue;
    const overlap = tokens.filter((token) => currentTokens.includes(token));
    const similarity = overlap.length / Math.max(currentTokens.length, tokens.length);
    if (similarity >= 0.45) count += 1;
  }
  return count;
}

function hasWorkflowVerb(tokens: readonly string[]): boolean {
  return tokens.some((token) => WORKFLOW_VERBS.has(token));
}

function hasReusableArtifactIntent(normalized: string): boolean {
  return /\b(reuse|keep using|update later|deploy|app|share|open later|turn this into)\b/.test(
    normalized,
  );
}

function isReusableAppArtifact(artifact: RecommendationArtifact): boolean {
  const filename = artifact.filename.toLowerCase();
  return (
    artifact.kind === "html" ||
    artifact.mimeType === "text/html" ||
    filename.endsWith(".html") ||
    filename.endsWith(".htm")
  );
}

function appMatchesArtifact(
  app: RecommendationApp,
  artifact: RecommendationArtifact,
): boolean {
  if (normalize(app.name) === normalize(artifact.title)) return true;
  const appTokens = new Set(significantTokens(`${app.name} ${app.slug ?? ""}`));
  const artifactTokens = significantTokens(
    `${artifact.title} ${artifact.filename}`,
  );
  const overlap = artifactTokens.filter((token) => appTokens.has(token));
  return overlap.length >= 2;
}

function cadenceFromMessage(normalized: string): string | null {
  if (/\bevery\s+weekday\b|\bweekdays\b/.test(normalized)) return "weekdays";
  const weekly = normalized.match(/\bevery\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (weekly?.[1]) return `weekly:${weekly[1]}`;
  if (/\bevery\s+week\b|\bweekly\b/.test(normalized)) return "weekly";
  if (/\bevery\s+day\b|\bdaily\b/.test(normalized)) return "daily";
  if (/\bevery\s+month\b|\bmonthly\b/.test(normalized)) return "monthly";
  return null;
}

function providerMention(normalized: string): string | null {
  if (/\b(github|gh|git hub|pull requests?|prs?|issues?)\b/.test(normalized)) {
    return "github";
  }
  return null;
}

function providerIntentBoost(
  message: string,
  providers: readonly string[],
): number {
  const normalized = normalize(message);
  return providers.some((provider) => providerMention(normalized) === provider)
    ? 2
    : 0;
}

function appIntentBoost(message: string): number {
  return /\b(app|dashboard|tool|portal|calculator|generator|open|launch|reuse|use|update)\b/.test(
    normalize(message),
  )
    ? 1
    : 0;
}

function significantTokens(value: string): string[] {
  return unique(
    normalize(value)
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3 && !STOPWORDS.has(token)),
  );
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function dedupeCandidates(
  candidates: readonly RecommendationCandidate[],
): RecommendationCandidate[] {
  const seen = new Set<string>();
  const out: RecommendationCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    out.push(candidate);
  }
  return out;
}

function formatList(values: readonly string[]): string {
  return values.map(label).join(", ");
}

function label(value: string): string {
  if (value === "github") return "GitHub";
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}
