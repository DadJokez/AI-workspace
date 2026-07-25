import { describe, expect, it } from "vitest";
import {
  buildRecommendationCandidates,
  isIdentifierToken,
} from "@/lib/recommendations";

const priorThreadRunStatusApp = {
  id: "app-run",
  name: "Run Status Explorer",
  description: "Status explorer for run CBX-4821 captured 20260722104500.",
  slug: "run-status-explorer",
  sourceThreadId: "thread-1",
  runnableNow: true,
};

describe("recommendation candidates", () => {
  it("suggests saving a repeated workflow as a skill", () => {
    const candidates = buildRecommendationCandidates({
      currentMessage:
        "What skill should I use to draft the weekly launch status update for the team?",
      recentUserMessages: [
        "Draft the weekly launch status update for the team",
        "Can you draft the launch status update this week?",
      ],
    });

    expect(candidates).toContainEqual(
      expect.objectContaining({
        type: "save_as_skill",
        requiresApproval: true,
        action: { kind: "create_skill", source: "repeated_workflow" },
      }),
    );
  });

  it("recommends a role/tool-relevant skill when its provider is approved", () => {
    const candidates = buildRecommendationCandidates({
      currentMessage: "What skill should I use for PRs that need my review?",
      roleContext: "Engineering lead responsible for pull request review flow.",
      connectedProviders: ["github"],
      approvedProviders: ["github"],
      skills: [
        {
          id: "skill-prs",
          name: "PR Review Briefing",
          description: "Summarize GitHub pull requests waiting for review.",
          mcpProviders: ["github"],
          runnableNow: true,
          sharedWithMe: true,
        },
      ],
    });

    expect(candidates[0]).toMatchObject({
      type: "run_existing_skill",
      title: "Run PR Review Briefing",
      requiresApproval: true,
      action: { kind: "run_skill", skillId: "skill-prs" },
    });
    expect(candidates[0]?.reason).toContain("connected GitHub tool access");
  });

  it("keeps digit-bearing tech tokens for skill matching (identifier filter is app-only)", () => {
    const candidates = buildRecommendationCandidates({
      currentMessage: "Which skill helps me audit s3 bucket policies?",
      connectedProviders: ["github"],
      approvedProviders: ["github"],
      skills: [
        {
          id: "skill-s3",
          name: "S3 Policy Audit",
          description: "Audit s3 bucket policies for public access.",
          mcpProviders: ["github"],
          runnableNow: true,
          sharedWithMe: true,
        },
      ],
    });
    expect(
      candidates.some(
        (c) => c.type === "run_existing_skill" && /S3 Policy Audit/.test(c.title),
      ),
    ).toBe(true);
  });

  it("does not recommend a skill during normal chat unless the user asks for skills", () => {
    const candidates = buildRecommendationCandidates({
      currentMessage: "What PRs need my review this week?",
      roleContext: "Engineering lead responsible for pull request review flow.",
      connectedProviders: ["github"],
      approvedProviders: ["github"],
      skills: [
        {
          id: "skill-prs",
          name: "PR Review Briefing",
          description: "Summarize GitHub pull requests waiting for review.",
          mcpProviders: ["github"],
          runnableNow: true,
        },
      ],
    });

    expect(candidates.some((c) => c.type === "run_existing_skill")).toBe(false);
  });

  it("does not recommend a provider-backed skill when provider approval is absent", () => {
    const candidates = buildRecommendationCandidates({
      currentMessage: "What PRs need my review this week?",
      connectedProviders: ["github"],
      approvedProviders: [],
      skills: [
        {
          id: "skill-prs",
          name: "PR Review Briefing",
          description: "Summarize GitHub pull requests waiting for review.",
          mcpProviders: ["github"],
          runnableNow: true,
        },
      ],
    });

    expect(candidates.some((c) => c.type === "run_existing_skill")).toBe(false);
  });

  it("does not recommend rerunning a skill already activated for the turn", () => {
    const candidates = buildRecommendationCandidates({
      currentMessage: "/developer-briefing summarize my recent GitHub work",
      connectedProviders: ["github"],
      approvedProviders: ["github"],
      suppressedSkillIds: ["skill-developer-briefing"],
      skills: [
        {
          id: "skill-developer-briefing",
          name: "Developer Briefing",
          description: "Summarize recent GitHub work into a developer briefing.",
          mcpProviders: ["github"],
          runnableNow: true,
        },
      ],
    });

    expect(candidates.some((c) => c.type === "run_existing_skill")).toBe(false);
  });

  it("suggests deploying a reusable HTML artifact as an app", () => {
    const candidates = buildRecommendationCandidates({
      currentMessage: "This dashboard is useful. Can we keep using it and update later?",
      artifacts: [
        {
          id: "artifact-1",
          title: "Sales Dashboard",
          filename: "sales-dashboard.html",
          kind: "html",
          mimeType: "text/html",
        },
      ],
    });

    expect(candidates).toContainEqual(
      expect.objectContaining({
        type: "deploy_artifact_as_app",
        requiresApproval: true,
        action: { kind: "deploy_app", artifactId: "artifact-1" },
      }),
    );
  });

  it("suggests opening an existing app from the capability graph before deploying a new one", () => {
    const candidates = buildRecommendationCandidates({
      currentMessage: "Open the sales dashboard app so I can update it",
      apps: [
        {
          id: "app-1",
          name: "Sales Dashboard",
          description: "Reusable sales reporting app.",
          slug: "sales-dashboard",
          runnableNow: true,
          sharedWithMe: true,
        },
      ],
      artifacts: [
        {
          id: "artifact-1",
          title: "Sales Dashboard",
          filename: "sales-dashboard.html",
          kind: "html",
          mimeType: "text/html",
        },
      ],
    });

    expect(candidates[0]).toMatchObject({
      type: "open_existing_app",
      title: "Open Sales Dashboard",
      requiresApproval: false,
      action: { kind: "open_app", appId: "app-1", slug: "sales-dashboard" },
    });
    expect(candidates.some((c) => c.type === "deploy_artifact_as_app")).toBe(
      false,
    );
  });

  it("does not recommend unrelated apps during Gmail follow-ups", () => {
    const apps = [
      {
        id: "app-theme",
        name: "Choose Your Theme",
        description: "Pick a theme for a reusable email app.",
        slug: "choose-your-theme",
        runnableNow: true,
      },
    ];

    expect(
      buildRecommendationCandidates({
        currentMessage: "Give me an update on any new emails since last time",
        apps,
      }).some((candidate) => candidate.type === "open_existing_app"),
    ).toBe(false);
    expect(
      buildRecommendationCandidates({
        currentMessage: "Why are you recommending me an app?",
        apps,
      }).some((candidate) => candidate.type === "open_existing_app"),
    ).toBe(false);
    expect(
      buildRecommendationCandidates({
        currentMessage: "Why did you show me the Choose Your Theme app?",
        apps,
      }).some((candidate) => candidate.type === "open_existing_app"),
    ).toBe(false);
    expect(
      buildRecommendationCandidates({
        currentMessage: "Open the Choose Your Theme app",
        apps,
      }),
    ).toContainEqual(
      expect.objectContaining({
        id: "open-app:app-theme",
        type: "open_existing_app",
      }),
    );
  });

  it("suppresses a repeated recommendation unless the user asks for it", () => {
    const apps = [
      {
        id: "app-sales",
        name: "Sales Dashboard",
        description: "Sales dashboard metrics and pipeline reporting.",
        slug: "sales-dashboard",
        runnableNow: true,
      },
    ];

    expect(
      buildRecommendationCandidates({
        currentMessage: "Compare sales dashboard metrics for the team",
        apps,
        suppressedCandidateIds: ["open-app:app-sales"],
      }),
    ).toEqual([]);
    expect(
      buildRecommendationCandidates({
        currentMessage: "Open the Sales Dashboard app",
        apps,
        suppressedCandidateIds: ["open-app:app-sales"],
      }),
    ).toContainEqual(
      expect.objectContaining({ id: "open-app:app-sales" }),
    );
  });

  it("still suggests deploying a new artifact when an unrelated app matches the prompt", () => {
    const candidates = buildRecommendationCandidates({
      currentMessage: "Reuse this sales forecast artifact as an app",
      apps: [
        {
          id: "app-1",
          name: "Sales Dashboard",
          slug: "sales-dashboard",
          runnableNow: true,
        },
      ],
      artifacts: [
        {
          id: "artifact-1",
          title: "Sales Forecast",
          filename: "sales-forecast.html",
          kind: "html",
          mimeType: "text/html",
        },
      ],
    });

    expect(candidates).toContainEqual(
      expect.objectContaining({
        type: "deploy_artifact_as_app",
        action: { kind: "deploy_app", artifactId: "artifact-1" },
      }),
    );
  });

  it("suggests scheduling a recurring workflow but keeps approval required", () => {
    const candidates = buildRecommendationCandidates({
      currentMessage: "Every Friday morning, send the team the weekly status update.",
      skills: [
        {
          id: "skill-status",
          name: "Weekly Status",
          description: "Write weekly team status updates.",
          mcpProviders: [],
          runnableNow: true,
        },
      ],
    });

    expect(candidates).toContainEqual(
      expect.objectContaining({
        type: "schedule_skill",
        requiresApproval: true,
        action: {
          kind: "create_schedule",
          skillId: "skill-status",
          cadenceHint: "weekly:friday",
        },
      }),
    );
  });

  it("does not treat cadence words in analyzed claims as scheduling intent", () => {
    const messages = [
      "Fact-check this claim: weekdays see roughly 40% more orders per day than weekends.",
      'Verify the statement "Every Monday, send the team a status update."',
      "Review these metrics:\n> Monthly revenue increased 12%.\n> Daily orders stayed flat.",
      "Draft a weekly status update from these notes.",
      "We send reports every Monday, according to the process document.",
    ];

    for (const currentMessage of messages) {
      const candidates = buildRecommendationCandidates({ currentMessage });
      expect(
        candidates.some((candidate) => candidate.type === "schedule_skill"),
        currentMessage,
      ).toBe(false);
    }
  });

  it("recognizes explicit scheduling directives without a mode toggle", () => {
    const messages = [
      "Please schedule this report every Monday.",
      "Can you send the team this report every Friday?",
      "Every weekday, prepare a status summary.",
      "Automate this as a weekly report.",
      "Remind me every month to review this dashboard.",
    ];

    for (const currentMessage of messages) {
      const candidates = buildRecommendationCandidates({ currentMessage });
      expect(
        candidates.some((candidate) => candidate.type === "schedule_skill"),
        currentMessage,
      ).toBe(true);
    }
  });

  it("does not match apps on shared run ids or timestamps", () => {
    const candidates = buildRecommendationCandidates({
      currentMessage: "Summarize run CBX-4821 from 20260722104500 for the team",
      apps: [
        {
          id: "app-notes",
          name: "CBX-4821 Notes",
          description: "Notes captured for CBX-4821 at 20260722104500.",
          slug: "cbx-4821-notes",
          runnableNow: true,
        },
      ],
    });

    expect(candidates.some((c) => c.type === "open_existing_app")).toBe(false);
  });

  it("still matches an app built in the current thread on token overlap", () => {
    const candidates = buildRecommendationCandidates({
      currentMessage: "Compare sales dashboard metrics for the team",
      currentThreadId: "thread-1",
      apps: [
        {
          id: "app-sales",
          name: "Sales Dashboard",
          description: "Sales dashboard metrics and pipeline reporting.",
          slug: "sales-dashboard",
          sourceThreadId: "thread-1",
          runnableNow: true,
        },
      ],
    });

    expect(candidates).toContainEqual(
      expect.objectContaining({
        id: "open-app:app-sales",
        type: "open_existing_app",
      }),
    );
  });

  it("does not resurface a prior-thread app via generic token overlap", () => {
    // Real-word overlap ("run", "status") would clear the old 2-token
    // minimum; thread provenance must block it without explicit intent.
    const candidates = buildRecommendationCandidates({
      currentMessage: "Check the status of run CBX-4821 from 20260722104500",
      currentThreadId: "thread-2",
      apps: [priorThreadRunStatusApp],
    });

    expect(candidates.some((c) => c.type === "open_existing_app")).toBe(false);
  });

  it("resurfaces a prior-thread app when the message names it", () => {
    const candidates = buildRecommendationCandidates({
      currentMessage: "Bring back the Run Status Explorer from last week",
      currentThreadId: "thread-2",
      apps: [priorThreadRunStatusApp],
    });

    expect(candidates).toContainEqual(
      expect.objectContaining({
        id: "open-app:app-run",
        type: "open_existing_app",
      }),
    );
  });

  it("does not resurface a single-common-word cross-thread app on bare prose", () => {
    const statusApp = {
      ...priorThreadRunStatusApp,
      name: "Status",
      slug: "status",
      description: "Deployment status board.",
    };
    const bareProse = buildRecommendationCandidates({
      currentMessage: "what's the status of the deployment",
      currentThreadId: "thread-2",
      apps: [statusApp],
    });
    expect(bareProse.some((c) => c.type === "open_existing_app")).toBe(false);

    // Word boundary: "statuses" must not hit "status" either.
    const boundary = buildRecommendationCandidates({
      currentMessage: "compare the statuses across environments",
      currentThreadId: "thread-2",
      apps: [statusApp],
    });
    expect(boundary.some((c) => c.type === "open_existing_app")).toBe(false);

    // Explicit app intent unlocks the single-word name.
    const withIntent = buildRecommendationCandidates({
      currentMessage: "open the Status app",
      currentThreadId: "thread-2",
      apps: [statusApp],
    });
    expect(withIntent.some((c) => c.type === "open_existing_app")).toBe(true);
  });

  it("resurfaces a prior-thread app on explicit app intent", () => {
    const candidates = buildRecommendationCandidates({
      currentMessage: "Open my run status app",
      currentThreadId: "thread-2",
      apps: [priorThreadRunStatusApp],
    });

    expect(candidates).toContainEqual(
      expect.objectContaining({
        id: "open-app:app-run",
        type: "open_existing_app",
      }),
    );
  });

  it("suggests using a connected tool directly when no skill is a better fit", () => {
    const candidates = buildRecommendationCandidates({
      currentMessage: "Can you check GitHub for my assigned issues?",
      connectedProviders: ["github"],
      approvedProviders: ["github"],
    });

    expect(candidates).toContainEqual(
      expect.objectContaining({
        type: "tool",
        requiresApproval: false,
        action: { kind: "connect_tool", provider: "github" },
      }),
    );
  });
});

describe("isIdentifierToken", () => {
  it("flags digit-bearing, hex, and cbx-prefixed tokens", () => {
    expect(isIdentifierToken("4821")).toBe(true);
    expect(isIdentifierToken("20260722104500")).toBe(true);
    expect(isIdentifierToken("41d4")).toBe(true);
    expect(isIdentifierToken("a716446655440000")).toBe(true);
    expect(isIdentifierToken("deadbeef")).toBe(true);
    expect(isIdentifierToken("cbx")).toBe(true);
    // Only the bare run-label prefix is dropped; cbx-prefixed WORDS are
    // legitimate names ("CBX Portal") and must keep matching.
    expect(isIdentifierToken("cbxrun")).toBe(false);
  });

  it("keeps real words", () => {
    expect(isIdentifierToken("dashboard")).toBe(false);
    expect(isIdentifierToken("sales")).toBe(false);
    expect(isIdentifierToken("status")).toBe(false);
    expect(isIdentifierToken("decade")).toBe(false);
    expect(isIdentifierToken("facade")).toBe(false);
  });
});
