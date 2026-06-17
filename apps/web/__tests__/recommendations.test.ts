import { describe, expect, it } from "vitest";
import { buildRecommendationCandidates } from "@/lib/recommendations";

describe("recommendation candidates", () => {
  it("suggests saving a repeated workflow as a skill", () => {
    const candidates = buildRecommendationCandidates({
      currentMessage: "Draft the weekly launch status update for the team",
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
