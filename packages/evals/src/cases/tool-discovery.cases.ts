import type { DiscoveryCatalogEntry } from "@ai-workspace/agent";
import type { EvalSuite, TurnTranscript } from "../types";
import {
  createGitHubFixtureTools,
  githubFixturePullRequests,
  githubFixtureRepo,
} from "../fixtures/github";

/**
 * Progressive tool discovery behavioral suite (#384 P2, extends the #364 P3
 * shape). The core-bundle contract has three behavioral edges:
 * 1. A request needing an unmounted provider activates it and answers in
 *    ONE user-visible turn — no re-prompting, no denial.
 * 2. Small talk from the core bundle triggers no discovery round-trip.
 * 3. A capability question about a discoverable provider is answered as a
 *    capability the assistant HAS — never "disconnected"/"no access".
 */

const GITHUB_PR_TOOL = "github__list_pull_requests";

const DISCOVERY_CATALOG: DiscoveryCatalogEntry[] = [
  {
    provider: "github",
    tool: "list_pull_requests",
    displayName: "List pull requests",
    description: `List pull requests in ${githubFixtureRepo.fullName}.`,
    category: "repos",
    action: "read",
  },
  {
    provider: "github",
    tool: "create_issue",
    displayName: "Create issue",
    description: "Create a GitHub issue.",
    category: "repos",
    action: "write",
  },
];

// Mirrors the P2 preamble's discoverable section — the eval tests the model
// against the same honesty framing production renders.
const DISCOVERY_PROMPT = [
  "You are Comparative, Rob's internal assistant.",
  "Mounted tools for this turn: comparative__search_tools and comparative__activate_tools (tool discovery).",
  "Available via tool discovery (connected, not yet mounted this conversation):",
  `- GitHub: repositories, issues, pull requests for ${githubFixtureRepo.fullName} (pre-authorized).`,
  "When the user's request needs one of these, call comparative__activate_tools with that provider (comparative__search_tools lists what each offers), then continue the task in this same turn — the tools mount from your next step. Never tell the user these are disconnected or unavailable, and never claim you already used a tool that is not mounted.",
  "Cite PR numbers and titles exactly from tool output. Never invent pull requests.",
].join("\n");

// The fast-path outcome: github is already mounted this turn (the user
// named it), so the preamble presents it as a live tool, not a discoverable
// one. The model should use it directly.
const FAST_PATH_PROMPT = [
  "You are Comparative, Rob's internal assistant.",
  `Mounted tools for this turn: ${GITHUB_PR_TOOL} (GitHub, for ${githubFixtureRepo.fullName}), plus comparative__search_tools and comparative__activate_tools (tool discovery).`,
  `Use ${GITHUB_PR_TOOL} before answering pull-request questions. Cite PR numbers and titles exactly from tool output. Never invent pull requests. Do not call the discovery tools for a provider that is already mounted.`,
].join("\n");

function activatedBeforeGitHubCall(t: TurnTranscript) {
  const activateAt = t.toolCallNames.indexOf("comparative__activate_tools");
  const githubAt = t.toolCallNames.indexOf(GITHUB_PR_TOOL);
  return {
    ok: activateAt >= 0 && githubAt > activateAt,
    detail: `calls: ${t.toolCallNames.join(", ") || "(none)"}`,
  };
}

function calledGitHubDirectlyNoDiscovery(t: TurnTranscript) {
  // Fast-path (#384 P3): the provider was named, so its bundle was
  // pre-activated before the model ran — the model must call github
  // directly and never spend a discovery round-trip on activate/search.
  const calledGitHub = t.toolCallNames.includes(GITHUB_PR_TOOL);
  const spentDiscovery =
    t.toolCallNames.includes("comparative__activate_tools") ||
    t.toolCallNames.includes("comparative__search_tools");
  return {
    ok: calledGitHub && !spentDiscovery,
    detail: `calls: ${t.toolCallNames.join(", ") || "(none)"}`,
  };
}

function answerCitesFixturePrs(t: TurnTranscript) {
  const missing = githubFixturePullRequests
    .map((pr) => `#${pr.number}`)
    .filter((expected) => !t.answer.includes(expected));
  return {
    ok: missing.length === 0,
    detail: missing.length
      ? `missing fixture PRs: ${missing.join(", ")}`
      : undefined,
  };
}

function didNotCallTools(t: TurnTranscript) {
  return {
    ok: t.toolCallNames.length === 0,
    detail: t.toolCallNames.length
      ? `unexpected calls: ${t.toolCallNames.join(", ")}`
      : undefined,
  };
}

const DENIAL_PHRASES = [
  "disconnected",
  "not connected",
  "no access",
  "don't have access",
  "do not have access",
  "cannot access",
  "can't access",
  "unavailable",
];

function neverDeniesGitHub(t: TurnTranscript) {
  const lowered = t.answer.toLowerCase();
  const denials = DENIAL_PHRASES.filter((phrase) => lowered.includes(phrase));
  return {
    ok: denials.length === 0,
    detail: denials.length ? `denial phrasing: ${denials.join(", ")}` : undefined,
  };
}

export const toolDiscoverySuite: EvalSuite = {
  capability: "tool-discovery",
  defaultModelId: "sonnet-4-6",
  defaultSeverity: "high",
  tags: ["connected-tools", "tool-discovery", "tool-selection"],
  cases: [
    {
      id: "discovery-cold-github-one-turn",
      description:
        "Cold conversation: 'check my PRs' activates github via discovery and answers with fixture data in one user-visible turn.",
      systemPrompt: DISCOVERY_PROMPT,
      input: `Check my open pull requests in ${githubFixtureRepo.fullName} and summarize them.`,
      tools: createGitHubFixtureTools(),
      toolDiscovery: {
        catalog: DISCOVERY_CATALOG,
        dynamicToolNames: [GITHUB_PR_TOOL],
      },
      providerStatus: { github: "discoverable_fixture" },
      contextReceipts: [
        "Core bundle turn: discovery tools mounted; github gated behind activation.",
      ],
      assertions: [
        { kind: "deterministic", label: "activates github before calling it", check: activatedBeforeGitHubCall },
        { kind: "deterministic", label: "answer cites fixture PRs", check: answerCitesFixturePrs },
        { kind: "deterministic", label: "never denies the capability", check: neverDeniesGitHub },
      ],
    },
    {
      id: "discovery-fastpath-named-provider-skips-roundtrip",
      description:
        "Fast-path: naming GitHub pre-activates it, so the model answers directly with no discovery round-trip (#384 P3).",
      systemPrompt: FAST_PATH_PROMPT,
      input: `Check my open pull requests in ${githubFixtureRepo.fullName} on GitHub and summarize them.`,
      tools: createGitHubFixtureTools(),
      toolDiscovery: {
        catalog: DISCOVERY_CATALOG,
        dynamicToolNames: [GITHUB_PR_TOOL],
        // The provider name in the message pre-activated github before the
        // model ran — it starts mounted, not gated behind discovery.
        activatedProviders: ["github"],
      },
      providerStatus: { github: "fastpath_mounted_fixture" },
      contextReceipts: [
        "Fast-path: 'GitHub' named in the message pre-activated the github bundle before the first model call.",
      ],
      assertions: [
        {
          kind: "deterministic",
          label: "calls github directly with no discovery round-trip",
          check: calledGitHubDirectlyNoDiscovery,
        },
        { kind: "deterministic", label: "answer cites fixture PRs", check: answerCitesFixturePrs },
        { kind: "deterministic", label: "never denies the capability", check: neverDeniesGitHub },
      ],
    },
    {
      id: "discovery-smalltalk-stays-core",
      description:
        "Small talk from the core bundle triggers no discovery round-trip and no tool calls.",
      systemPrompt: DISCOVERY_PROMPT,
      input: "How are you today?",
      tools: createGitHubFixtureTools(),
      toolDiscovery: {
        catalog: DISCOVERY_CATALOG,
        dynamicToolNames: [GITHUB_PR_TOOL],
      },
      providerStatus: { github: "discoverable_fixture" },
      assertions: [
        { kind: "deterministic", label: "no tool calls", check: didNotCallTools },
      ],
    },
    {
      id: "discovery-capability-honesty",
      description:
        "A capability question about a discoverable provider is never answered with a denial.",
      systemPrompt: DISCOVERY_PROMPT,
      input: "Can you look at my GitHub pull requests for me?",
      tools: createGitHubFixtureTools(),
      toolDiscovery: {
        catalog: DISCOVERY_CATALOG,
        dynamicToolNames: [GITHUB_PR_TOOL],
      },
      providerStatus: { github: "discoverable_fixture" },
      assertions: [
        { kind: "deterministic", label: "never denies the capability", check: neverDeniesGitHub },
      ],
    },
  ],
};
