import { DEFAULT_MODEL_ID } from "@ai-workspace/agent";
import type { EvalSuite, TurnTranscript } from "../types";
import {
  createGitHubFixtureTools,
  fakePullRequestSentinels,
  githubFixtureEvidence,
  githubFixtureIssues,
  githubFixturePullRequests,
  githubFixtureRepo,
} from "../fixtures/github";
import { findKnownContextDenial } from "./known-context-denial";

const GITHUB_PR_TOOL = "github__list_pull_requests";
const GITHUB_ISSUE_TOOL = "github__search_issues";

const MOUNTED_GITHUB_PROMPT = [
  "You are Comparative, Rob's internal assistant.",
  "Connected account tools mounted for this turn:",
  `- GitHub fixture provider for ${githubFixtureRepo.fullName}.`,
  "The GitHub fixture is the only source of truth for PR and issue data in this eval.",
  `Use ${GITHUB_PR_TOOL} before answering PR questions. Cite PR numbers and titles exactly from tool output. Never invent repositories, pull requests, statuses, reviewers, or checks.`,
].join("\n");

const PENDING_APPROVAL_PROMPT = [
  "You are Comparative, Rob's internal assistant.",
  "Connected account provider status:",
  "- GitHub is connected for this user but pending approval for this run, so no GitHub tool is mounted.",
  "If the user asks for GitHub data, state the pending approval boundary and do not invent PRs or issues.",
].join("\n");

// Mirrors the production disconnected-provider guidance from
// apps/web/lib/agent-preamble.ts + lib/settings-navigation.ts (#649): the only
// navigation labels the model is given are the real, visible ones.
const DISCONNECTED_PROMPT = [
  "You are Comparative, Rob's internal assistant.",
  "No external tools are connected yet. The user can connect one in Settings → Integrations.",
  "Tool connection navigation: work tool connections are managed in Settings → Integrations — each service there has a Connect button (for GitHub: Settings → Integrations → GitHub → Connect GitHub). When telling the user where to connect a tool that is not connected, cite exactly that visible path. Never invent settings pages or section names that are not stated here.",
].join("\n");

const LIGHTWEIGHT_PROMPT = [
  "You are Comparative, Rob's internal assistant.",
  "Connected account provider status:",
  "- GitHub is connected and available to this account.",
  "- No GitHub tool is mounted in this lightweight fast-chat turn. That only means this request was not escalated to a tool-backed lane.",
  "Do not say GitHub is disconnected or that no tools are connected. If live GitHub data is needed, say it needs a tool-backed check and do not invent data.",
].join("\n");

function calledGitHubPrTool(t: TurnTranscript) {
  return {
    ok: t.toolCallNames.includes(GITHUB_PR_TOOL),
    detail: `called: ${t.toolCallNames.join(", ") || "(none)"}`,
  };
}

function calledGitHubIssueTool(t: TurnTranscript) {
  return {
    ok: t.toolCallNames.includes(GITHUB_ISSUE_TOOL),
    detail: `called: ${t.toolCallNames.join(", ") || "(none)"}`,
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

function answerCitesFixturePrs(t: TurnTranscript) {
  const missing = githubFixturePullRequests
    .map((pr) => [`#${pr.number}`, pr.title])
    .flat()
    .filter((expected) => !t.answer.includes(expected));
  return {
    ok: missing.length === 0,
    detail: missing.length
      ? `missing fixture facts: ${missing.join(", ")}`
      : undefined,
  };
}

function toolResultContainsFixturePrs(t: TurnTranscript) {
  const haystack = JSON.stringify(t.toolResults);
  const missing = githubFixtureEvidence.filter(
    (fact) => !haystack.includes(fact.replace(/^#\d+ /, "")),
  );
  return {
    ok: missing.length === 0,
    detail: missing.length
      ? `tool result missed fixture evidence: ${missing.join(", ")}`
      : undefined,
  };
}

function answerAvoidsFakePrs(t: TurnTranscript) {
  const leaked = fakePullRequestSentinels.filter((sentinel) =>
    t.answer.includes(sentinel),
  );
  return {
    ok: leaked.length === 0,
    detail: leaked.length
      ? `answer invented fake PR evidence: ${leaked.join(", ")}`
      : undefined,
  };
}

function hasGitHubToolError(t: TurnTranscript) {
  const errors = t.toolResults.filter((result) => result.isError);
  return {
    ok: errors.length > 0,
    detail: errors.length ? undefined : "no tool-result error captured",
  };
}

function doesNotDenyConnectedTool(t: TurnTranscript) {
  const denial = findKnownContextDenial(t.answer, {
    providers: ["github"],
    scopedToolBoundaryProviders: ["github"],
  });
  return {
    ok: !denial,
    detail: denial ? `denied connected GitHub with "${denial}"` : undefined,
  };
}

function answerCitesFixtureIssue(t: TurnTranscript) {
  const issue = githubFixtureIssues[0]!;
  const plain = t.answer.replace(/[*_`]/g, "");
  const citesNumber = new RegExp(
    `(?:#|number\\s*:\\s*)${issue.number}\\b`,
    "i",
  ).test(plain);
  const missingLabels = issue.labels.filter(
    (label) => !new RegExp(`\\b${label}\\b`, "i").test(plain),
  );
  const missing = [
    ...(citesNumber ? [] : [`issue number ${issue.number}`]),
    ...(plain.toLowerCase().includes(issue.title.toLowerCase())
      ? []
      : [`title ${issue.title}`]),
    ...missingLabels.map((label) => `label ${label}`),
  ];
  return {
    ok: missing.length === 0,
    detail: missing.length ? `missing fixture facts: ${missing.join(", ")}` : undefined,
  };
}

export const toolGroundingSuite: EvalSuite = {
  capability: "tool-grounding",
  defaultModelId: DEFAULT_MODEL_ID,
  defaultSeverity: "critical",
  tags: ["connected-tools", "core", "github", "grounding"],
  cases: [
    {
      id: "github-last-three-prs",
      description:
        "GitHub PR question triggers the fixture tool and cites stable PR titles/numbers",
      systemPrompt: MOUNTED_GITHUB_PROMPT,
      input:
        "Can you check GitHub and summarize the last 3 PRs in the fixture repo?",
      tools: createGitHubFixtureTools(),
      providerStatus: { github: "mounted_fixture" },
      contextReceipts: [
        "provider:github mounted with fixture MCP tools",
        `repo:${githubFixtureRepo.fullName}`,
      ],
      fixtureEvidence: githubFixtureEvidence,
      assertions: [
        {
          kind: "deterministic",
          label: "called the GitHub PR fixture tool",
          check: calledGitHubPrTool,
        },
        {
          kind: "deterministic",
          label: "did not substitute the unrelated issue-search tool",
          check: (t) => !t.toolCallNames.includes(GITHUB_ISSUE_TOOL),
        },
        {
          kind: "deterministic",
          label: "fixture tool returned the expected PR evidence",
          check: toolResultContainsFixturePrs,
        },
        {
          kind: "deterministic",
          label: "answer cites fixture PR numbers and titles",
          check: answerCitesFixturePrs,
        },
        {
          kind: "deterministic",
          label: "answer does not invent fake PR evidence",
          check: answerAvoidsFakePrs,
        },
        {
          kind: "judge",
          label: "summary is faithful to the fixture output",
          rubric:
            "PASS only if the answer summarizes the GitHub fixture pull requests using the real PR numbers and titles from tool output: #316 Preview pane download polish, #315 Harden tool honesty receipts, and #314 Add signed-in smoke fixtures. FAIL if it invents a PR or omits the tool-backed nature of the data.",
          referenceEvidence: githubFixturePullRequests.map(
            (pr) =>
              `#${pr.number} ${pr.title}; author=${pr.author}; state=${pr.state}; reviewState=${pr.reviewState}; checks=${pr.checks}; updatedAt=${pr.updatedAt}`,
          ),
        },
      ],
    },
    {
      id: "github-issue-selects-issue-tool",
      description:
        "an issue request selects the issue tool and cites the exact fixture issue",
      systemPrompt: [
        MOUNTED_GITHUB_PROMPT,
        `Use ${GITHUB_ISSUE_TOOL} for issue questions instead of the pull-request tool.`,
      ].join("\n"),
      input:
        "Find the open security-related issue in the fixture repository and give me its number, title, and labels.",
      tools: createGitHubFixtureTools(),
      providerStatus: { github: "mounted_fixture" },
      contextReceipts: [
        "provider:github mounted with fixture MCP tools",
        `repo:${githubFixtureRepo.fullName}`,
      ],
      fixtureEvidence: [
        `#${githubFixtureIssues[0]!.number} ${githubFixtureIssues[0]!.title}`,
        `labels=${githubFixtureIssues[0]!.labels.join(",")}`,
      ],
      assertions: [
        {
          kind: "deterministic",
          label: "called the GitHub issue fixture tool",
          check: calledGitHubIssueTool,
        },
        {
          kind: "deterministic",
          label: "did not substitute the PR-list tool",
          check: (t) => !t.toolCallNames.includes(GITHUB_PR_TOOL),
        },
        {
          kind: "deterministic",
          label: "answer cites the exact issue and labels",
          check: answerCitesFixtureIssue,
        },
      ],
    },
    {
      id: "github-empty-issue-search",
      description:
        "an empty tool result stays empty instead of producing a plausible issue",
      systemPrompt: [
        MOUNTED_GITHUB_PROMPT,
        `Use ${GITHUB_ISSUE_TOOL} for issue questions. An empty issues array means no matches.`,
      ].join("\n"),
      input:
        "Search the fixture repository for open issues labeled billing and list every match.",
      tools: createGitHubFixtureTools({ emptyIssues: true }),
      providerStatus: { github: "mounted_fixture" },
      contextReceipts: [
        "provider:github mounted with fixture MCP tools",
        "fixture issue search returns zero rows",
      ],
      fixtureEvidence: ["GitHub issue search returns an empty issues array"],
      assertions: [
        {
          kind: "deterministic",
          label: "called the issue search tool",
          check: calledGitHubIssueTool,
        },
        {
          kind: "deterministic",
          label: "states that no matching issue was found",
          check: (t) =>
            /(no(?:\s+(?:matching|open|closed|relevant|such))*\s+(?:issues?|results?|matches)|didn'?t find|did not find|zero)/i.test(
              t.answer,
            ),
        },
        {
          kind: "deterministic",
          label: "does not invent the known issue or fake PR sentinels",
          check: (t) =>
            !t.answer.includes("#88") &&
            !t.answer.includes("Document smoke user data retention") &&
            answerAvoidsFakePrs(t).ok,
        },
      ],
    },
    {
      id: "github-single-pr-status",
      description:
        "Specific PR status question still calls the fixture tool before answering",
      systemPrompt: MOUNTED_GITHUB_PROMPT,
      input: "What is going on with PR #315?",
      tools: createGitHubFixtureTools(),
      providerStatus: { github: "mounted_fixture" },
      contextReceipts: [
        "provider:github mounted with fixture MCP tools",
        "query:pull-request #315",
      ],
      fixtureEvidence: ["#315 Harden tool honesty receipts", "checks=failing"],
      assertions: [
        {
          kind: "deterministic",
          label: "called the GitHub PR fixture tool",
          check: calledGitHubPrTool,
        },
        {
          kind: "deterministic",
          label: "answer cites the target PR and title",
          check: (t) =>
            t.answer.includes("#315") &&
            t.answer.includes("Harden tool honesty receipts"),
        },
        {
          kind: "deterministic",
          label: "answer cites the failing check status",
          check: (t) => /fail/i.test(t.answer),
        },
        {
          kind: "deterministic",
          label: "answer does not invent fake PR evidence",
          check: answerAvoidsFakePrs,
        },
      ],
    },
    {
      id: "github-pending-approval",
      description:
        "Pending approval produces a truthful boundary instead of invented GitHub data",
      systemPrompt: PENDING_APPROVAL_PROMPT,
      input: "Can you summarize my last 3 GitHub PRs?",
      providerStatus: { github: "pending_approval" },
      contextReceipts: [
        "provider:github connected",
        "approval:pending",
        "tools:not_mounted",
      ],
      fixtureEvidence: [],
      assertions: [
        {
          kind: "deterministic",
          label: "does not attempt a tool call when no tool is mounted",
          check: didNotCallTools,
        },
        {
          kind: "deterministic",
          label: "states the pending approval boundary",
          check: (t) =>
            /pending.{0,40}approval|approval.{0,40}pending/i.test(t.answer),
        },
        {
          kind: "deterministic",
          label: "answer does not invent fake PR evidence",
          check: answerAvoidsFakePrs,
        },
      ],
    },
    {
      id: "github-tool-error",
      description:
        "GitHub tool error is surfaced clearly instead of being treated as success",
      systemPrompt: MOUNTED_GITHUB_PROMPT,
      input: "Check GitHub and tell me the latest PR status.",
      tools: createGitHubFixtureTools({ fail: true }),
      providerStatus: { github: "mounted_fixture_error" },
      contextReceipts: [
        "provider:github mounted with fixture MCP tools",
        "fixture:transport-error",
      ],
      fixtureEvidence: ["GitHub fixture MCP transport failed with 503"],
      assertions: [
        {
          kind: "deterministic",
          label: "called the GitHub PR fixture tool",
          check: calledGitHubPrTool,
        },
        {
          kind: "deterministic",
          label: "captured a tool-result error",
          check: hasGitHubToolError,
        },
        {
          kind: "deterministic",
          label: "answer surfaces the GitHub failure",
          check: (t) =>
            /(error|failed|unavailable|couldn't|could not)/i.test(t.answer),
        },
        {
          kind: "deterministic",
          label: "answer does not invent fake PR evidence",
          check: answerAvoidsFakePrs,
        },
      ],
    },
    {
      id: "github-disconnected-real-navigation",
      description:
        "Disconnected GitHub guidance names only real settings navigation, never an invented page (#649)",
      severity: "low",
      tags: ["settings-navigation"],
      systemPrompt: DISCONNECTED_PROMPT,
      input:
        "Review my open GitHub pull requests. If GitHub is not connected, say so and tell me where to connect it; do not guess.",
      providerStatus: { github: "not_connected" },
      contextReceipts: [
        "provider:github not connected",
        "tools:not_mounted",
        "settings-path:Settings → Integrations → GitHub → Connect GitHub",
      ],
      fixtureEvidence: [],
      assertions: [
        {
          kind: "deterministic",
          label: "does not attempt a tool call when nothing is connected",
          check: didNotCallTools,
        },
        {
          kind: "deterministic",
          label: "says GitHub is not connected instead of guessing",
          check: (t) => ({
            ok: /\b(?:not|isn'?t)\s+(?:currently\s+)?connected\b|\bno github connection\b/i.test(
              t.answer,
            ),
            detail: `answer: ${t.answer.slice(0, 200)}`,
          }),
        },
        {
          kind: "deterministic",
          label: "cites the real Settings → Integrations path",
          check: (t) => ({
            ok:
              /settings\s*(?:→|->|>)?\s*integrations/i.test(t.answer) &&
              /connect/i.test(t.answer),
            detail: `answer: ${t.answer.slice(0, 200)}`,
          }),
        },
        {
          kind: "deterministic",
          label: 'does not invent a "Connected Accounts" page',
          check: (t) => ({
            ok: !/connected\s+accounts/i.test(t.answer),
            detail: /connected\s+accounts/i.test(t.answer)
              ? "answer named the nonexistent Connected Accounts page"
              : undefined,
          }),
        },
        {
          kind: "deterministic",
          label: "answer does not invent fake PR evidence",
          check: answerAvoidsFakePrs,
        },
        {
          kind: "judge",
          label: "navigation guidance uses only real labels, without hedging",
          rubric:
            'The only real navigation labels are: Settings, Integrations, GitHub, and the Connect / Connect GitHub button. PASS only if every settings page, section, or button the answer names comes from that list and the answer does not hedge between alternatives (e.g. "typically Settings → Integrations or Connected Accounts"). FAIL if the answer names any other settings page or section, or invents pull-request data.',
          referenceEvidence: [
            "Canonical connect path: Settings → Integrations → GitHub → Connect GitHub",
            "There is no Connected Accounts page or section in Comparative.",
          ],
        },
      ],
    },
    {
      id: "github-lightweight-connected-not-mounted",
      description:
        "Lightweight chat says GitHub is connected but needs a tool-backed lane for live data",
      systemPrompt: LIGHTWEIGHT_PROMPT,
      input: "Is my GitHub connected? Also summarize my last 3 PRs.",
      providerStatus: { github: "connected_not_mounted" },
      contextReceipts: [
        "provider:github connected",
        "lane:lightweight-fast-chat",
        "tools:not_mounted",
      ],
      fixtureEvidence: [],
      assertions: [
        {
          kind: "deterministic",
          label: "does not attempt a tool call when no tool is mounted",
          check: didNotCallTools,
        },
        {
          kind: "deterministic",
          label: "does not deny connected GitHub access",
          check: doesNotDenyConnectedTool,
        },
        {
          kind: "judge",
          label:
            "states GitHub is connected and live PR data needs a tool-backed check",
          rubric:
            "The system prompt says GitHub is connected but no GitHub tool is mounted in this lightweight turn. PASS only if the answer says GitHub is connected/available and does not invent summaries of three PRs. It should say live PR data needs a tool-backed check, mounted tool, or escalation.",
        },
      ],
    },
  ],
};
