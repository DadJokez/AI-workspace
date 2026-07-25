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
  /** Thread the app was built in; null/undefined = unknown provenance. */
  sourceThreadId?: string | null;
  runnableNow?: boolean;
  sharedWithMe?: boolean;
}

export interface BuildRecommendationCandidatesInput {
  currentMessage: string;
  currentThreadId?: string | null;
  recentUserMessages?: readonly string[];
  roleContext?: string | null;
  connectedProviders?: readonly string[];
  approvedProviders?: readonly string[];
  skills?: readonly RecommendationSkill[];
  apps?: readonly RecommendationApp[];
  artifacts?: readonly RecommendationArtifact[];
  suppressedSkillIds?: readonly string[];
  suppressedCandidateIds?: readonly string[];
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

const APP_MATCH_GENERIC_TOKENS = new Set([
  "app",
  "apps",
  "email",
  "emails",
  "mail",
  "message",
  "messages",
  "new",
  "open",
  "tool",
  "tools",
  "update",
  "why",
  "work",
]);

export function buildRecommendationCandidates({
  currentMessage,
  currentThreadId,
  recentUserMessages = [],
  roleContext,
  connectedProviders = [],
  approvedProviders = connectedProviders,
  skills = [],
  apps = [],
  artifacts = [],
  suppressedSkillIds = [],
  suppressedCandidateIds = [],
}: BuildRecommendationCandidatesInput): RecommendationCandidate[] {
  const candidates: RecommendationCandidate[] = [];
  const normalized = normalize(currentMessage);
  const currentTokens = significantTokens(currentMessage);
  const approved = new Set(approvedProviders.map((p) => p.toLowerCase()));
  const connected = new Set(connectedProviders.map((p) => p.toLowerCase()));
  const suppressedSkills = new Set(suppressedSkillIds);
  const suppressedCandidates = new Set(suppressedCandidateIds);
  const skillRecommendationsRequested =
    hasInlineSkillRecommendationIntent(normalized);

  const repeatedCount = countSimilarWorkflow(
    currentTokens,
    recentUserMessages,
  );
  if (
    skillRecommendationsRequested &&
    repeatedCount >= 2 &&
    hasWorkflowVerb(currentTokens)
  ) {
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
  if (
    skillRecommendationsRequested &&
    matchingSkill &&
    !suppressedSkills.has(matchingSkill.id)
  ) {
    const providers = unique(
      mcpProvidersOnly(matchingSkill.mcpProviders).map((p) => p.toLowerCase()),
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

  const matchingApp = hasRecommendationDiscussionIntent(normalized)
    ? null
    : bestMatchingApp({
        message: currentMessage,
        roleContext,
        apps,
        currentThreadId,
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
      title: "Publish this as an app",
      reason: `${appArtifact.title} looks reusable, so it can become an app you can open and update later.`,
      requiresApproval: true,
      action: { kind: "deploy_app", artifactId: appArtifact.id },
      metadata: { artifactId: appArtifact.id, filename: appArtifact.filename },
    });
  }

  const cadenceHint = cadenceFromSchedulingInstruction(currentMessage);
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

  return dedupeCandidates(candidates).filter(
    (candidate) =>
      !suppressedCandidates.has(candidate.id) ||
      hasExplicitRecommendationAction(normalized, candidate.type),
  );
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
      mcpProvidersOnly(skill.mcpProviders).map((p) => p.toLowerCase()),
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

function mcpProvidersOnly(providers: readonly string[] | undefined): string[] {
  return (providers ?? []).filter((provider) => provider !== "web");
}

function bestMatchingApp({
  message,
  roleContext,
  apps,
  currentThreadId,
}: {
  message: string;
  roleContext?: string | null;
  apps: readonly RecommendationApp[];
  currentThreadId?: string | null;
}): RecommendationApp | null {
  const queryTokens = new Set([
    ...significantTokens(message),
    ...significantTokens(roleContext ?? ""),
  ]);
  let best: { app: RecommendationApp; score: number } | null = null;
  const explicitAppIntent = hasExplicitAppIntent(normalize(message));

  for (const app of apps) {
    if (app.runnableNow === false) continue;
    // An app built in another thread must be asked for by explicit app intent
    // or by name; generic token overlap alone cannot resurface it (#643).
    const crossThread =
      typeof app.sourceThreadId === "string" &&
      app.sourceThreadId !== currentThreadId;
    const namedInMessage =
      crossThread && messageNamesApp(message, app, explicitAppIntent);
    if (crossThread && !explicitAppIntent && !namedInMessage) continue;

    // Identifier-like tokens are excluded from APP overlap only (#643);
    // skills/workflows/artifacts keep the full tokenizer so tech tokens
    // like s3 or gpt4 still match there.
    const appTokens = significantTokens(
      `${app.name} ${app.description ?? ""}`,
    ).filter((token) => !isIdentifierToken(token));
    const overlap = appTokens.filter(
      (token) =>
        queryTokens.has(token) && !APP_MATCH_GENERIC_TOKENS.has(token),
    );
    const minimumOverlap = namedInMessage ? 0 : explicitAppIntent ? 1 : 2;
    if (overlap.length < minimumOverlap) continue;

    const score = overlap.length + appIntentBoost(message);
    if (!best || score > best.score) {
      best = { app, score };
    }
  }

  return best?.app ?? null;
}

// A cross-thread exact-name trigger bypasses token overlap entirely, so it
// must not fire on incidental prose: matches are word-bounded (no
// "statuses" hitting "status"), and a single-word name — user-authored, so
// possibly a common word like "Status" — only counts alongside explicit app
// intent ("open the Status app"), never bare mention.
function messageNamesApp(
  message: string,
  app: RecommendationApp,
  explicitAppIntent: boolean,
): boolean {
  const normalized = normalize(message);
  const candidates = [normalize(app.name)];
  if (app.slug) {
    const slug = normalize(app.slug);
    candidates.push(slug, slug.replace(/-/g, " "));
  }
  for (const candidate of candidates) {
    if (candidate.length < 3) continue;
    const escaped = candidate
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/[\s-]+/g, "[\\s-]+");
    if (!new RegExp(`\\b${escaped}\\b`).test(normalized)) continue;
    const contentWords = candidate
      .split(/[\s-]+/)
      .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
    if (contentWords.length >= 2 || explicitAppIntent) return true;
  }
  return false;
}

function hasExplicitAppIntent(normalized: string): boolean {
  return (
    /\b(open|launch|use|reuse|run|edit|update|show|find|go to)\b/.test(
      normalized,
    ) &&
    /\b(app|dashboard|tool|portal|calculator|generator|picker)\b/.test(
      normalized,
    )
  );
}

function hasRecommendationDiscussionIntent(normalized: string): boolean {
  return (
    /\b(why|how come|explain)\b/.test(normalized) &&
    /\b(recommend|recommendation|recommended|suggest|suggestion|suggested|show|showing|shown|card|app)\b/.test(
      normalized,
    )
  );
}

function hasExplicitRecommendationAction(
  normalized: string,
  type: RecommendationType,
): boolean {
  if (type === "open_existing_app" || type === "deploy_artifact_as_app") {
    return hasExplicitAppIntent(normalized);
  }
  if (type === "run_existing_skill" || type === "save_as_skill") {
    return /\b(run|use|create|save)\b.{0,50}\b(skill|workflow|automation)\b/.test(
      normalized,
    );
  }
  if (type === "schedule_skill") {
    return /\b(schedule|every|daily|weekly|monthly)\b/.test(normalized);
  }
  return /\b(connect|use)\b/.test(normalized);
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

function hasInlineSkillRecommendationIntent(normalized: string): boolean {
  return /\b(recommend|suggest|which|what|show|find|available|catalog|library)\b.*\b(skills?|capabilit(?:y|ies)|automations?|workflows?)\b|\b(skills?|capabilit(?:y|ies)|automations?|workflows?)\b.*\b(recommend|suggest|should i use|can i use|available|catalog|library)\b/.test(
    normalized,
  );
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

function cadenceFromSchedulingInstruction(message: string): string | null {
  const normalized = normalize(stripQuotedSchedulingData(message));
  const cadence = cadenceFromMessage(normalized);
  if (!cadence) return null;

  const explicitSchedulingDirective =
    /\b(schedule|automate)\b/.test(normalized) ||
    /\bremind\s+(?:me|us|the team)\b/.test(normalized) ||
    /\bset\s+(?:this|it|up)\b.{0,80}\b(?:recurring|every|daily|weekly|monthly|weekdays?)\b/.test(
      normalized,
    );
  if (explicitSchedulingDirective) return cadence;

  // Cadence words in reports and claims are data, not action intent. Without
  // an explicit scheduling verb, accept only an imperative paired with an
  // "every ..." recurrence phrase (for example, "Every Friday, send...").
  if (
    !/\bevery\s+(?:weekday|day|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(
      normalized,
    )
  ) {
    return null;
  }
  const action =
    "(?:send|run|email|post|create|generate|prepare|check|summarize|publish|notify|draft|review|triage|update)";
  const directivePrefix =
    "(?:(?:please|can you|could you|would you|i (?:want|need) you to)\\s+)?";
  const cadencePattern =
    "(?:every\\s+(?:weekday|day|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday))";
  return new RegExp(
    `^(?:${directivePrefix}${action}\\b.{0,120}\\b${cadencePattern}\\b|${cadencePattern}\\b.{0,120}\\b${action}\\b)`,
  ).test(normalized)
    ? cadenceFromMessage(normalized)
    : null;
}

function stripQuotedSchedulingData(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/"[^"\n]*"/g, " ")
    .replace(/“[^”\n]*”/g, " ")
    .replace(/^\s*>.*$/gm, " ");
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

/**
 * Identifier-like tokens (run ids, timestamps, uuid fragments, the bare CBX
 * run-label prefix) must not count as semantic overlap between APP requests
 * (#643). Applied at the app-matching call sites only — the shared
 * tokenizer below keeps digit-bearing tech tokens (s3, gpt4, p95) so
 * skill/workflow/artifact matching is unaffected.
 */
export function isIdentifierToken(token: string): boolean {
  return /\d/.test(token) || /^[0-9a-f]{8,}$/.test(token) || token === "cbx";
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
