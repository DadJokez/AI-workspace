import { describe, expect, it } from "vitest";
import {
  buildCapabilityGraph,
  recommendationInputsFromCapabilityGraph,
  renderCapabilitySummaryForPrompt,
} from "@/lib/capability-graph";

const NOW = new Date("2026-06-14T00:00:00.000Z");

describe("capability graph", () => {
  it("keeps connected-but-not-mounted tools runnable and explicit", () => {
    const graph = buildCapabilityGraph({
      userId: "user-1",
      providerStatus: {
        connectedProviders: ["github"],
        allowedProviders: ["github"],
        deniedProviders: [],
      },
      mountedProviders: [],
      now: NOW,
    });

    expect(graph.providers[0]).toMatchObject({
      id: "provider:github",
      runnableNow: true,
      needsApproval: false,
      mountedNow: false,
      status: "approved",
    });
    expect(renderCapabilitySummaryForPrompt(graph)).toContain(
      "Not mounted on this turn",
    );
  });

  it("marks shared skills as runnable when their providers are approved", () => {
    const graph = buildCapabilityGraph({
      userId: "user-1",
      providerStatus: {
        connectedProviders: ["github"],
        allowedProviders: ["github"],
        deniedProviders: [],
      },
      skills: [
        {
          id: "skill-1",
          slug: "weekly-pr-summary",
          name: "Weekly PR Summary",
          ownerUserId: "other-user",
          isStarter: false,
          mcpProviders: ["github"],
          sharedWithMe: true,
        },
      ],
      now: NOW,
    });

    expect(graph.skills[0]).toMatchObject({
      source: "shared",
      runnableNow: true,
      requiresProviders: ["github"],
      readyProviders: ["github"],
    });
  });

  it("marks shared deployed apps as openable capabilities", () => {
    const graph = buildCapabilityGraph({
      userId: "user-1",
      providerStatus: emptyProviders(),
      apps: [
        {
          id: "app-1",
          slug: "sales-dashboard",
          name: "Sales Dashboard",
          ownerUserId: "other-user",
          status: "deployed",
          liveArtifactId: "artifact-1",
          sharedWithMe: true,
        },
      ],
      now: NOW,
    });

    expect(graph.apps[0]).toMatchObject({
      source: "shared",
      runnableNow: true,
      status: "deployed",
    });
  });

  it("states pending provider approval without calling the provider missing", () => {
    const graph = buildCapabilityGraph({
      userId: "user-1",
      providerStatus: {
        connectedProviders: ["github"],
        allowedProviders: [],
        deniedProviders: ["github"],
      },
      skills: [
        {
          id: "skill-1",
          slug: "triage-gh",
          name: "GitHub Triage",
          ownerUserId: "user-1",
          isStarter: false,
          mcpProviders: ["github"],
        },
      ],
      now: NOW,
    });

    expect(graph.providers[0]).toMatchObject({
      status: "pending_approval",
      needsApproval: true,
      missingProviders: [],
    });
    expect(graph.skills[0]).toMatchObject({
      runnableNow: false,
      needsApproval: true,
      missingProviders: [],
      pendingApprovalProviders: ["github"],
    });
  });

  it("marks provider-dependent skills not runnable when no provider is connected", () => {
    const graph = buildCapabilityGraph({
      userId: "user-1",
      providerStatus: emptyProviders(),
      skills: [
        {
          id: "skill-1",
          slug: "triage-gh",
          name: "GitHub Triage",
          ownerUserId: "user-1",
          isStarter: false,
          mcpProviders: ["github"],
        },
      ],
      now: NOW,
    });

    expect(graph.providers).toEqual([]);
    expect(graph.skills[0]).toMatchObject({
      runnableNow: false,
      needsApproval: false,
      missingProviders: ["github"],
      pendingApprovalProviders: [],
    });
    expect(renderCapabilitySummaryForPrompt(graph)).toContain("Tools: none");
  });

  it("includes enabled schedules as owned runnable capabilities", () => {
    const graph = buildCapabilityGraph({
      userId: "user-1",
      providerStatus: emptyProviders(),
      schedules: [
        {
          id: "schedule-1",
          skillId: "skill-1",
          skillName: "Weekly Status",
          cadence: "0 8 * * FRI",
          timezone: "America/New_York",
          enabled: true,
          nextRunAt: "2026-06-19T12:00:00.000Z",
        },
      ],
      now: NOW,
    });

    expect(graph.schedules[0]).toMatchObject({
      source: "owned",
      runnableNow: true,
      status: "enabled",
    });
  });

  it("projects graph capabilities into recommendation inputs", () => {
    const graph = buildCapabilityGraph({
      userId: "user-1",
      providerStatus: {
        connectedProviders: ["github"],
        allowedProviders: ["github"],
        deniedProviders: [],
      },
      skills: [
        {
          id: "skill-1",
          slug: "weekly-pr-summary",
          name: "Weekly PR Summary",
          description: "Summarize GitHub pull requests.",
          ownerUserId: "other-user",
          isStarter: false,
          mcpProviders: ["github"],
          sharedWithMe: true,
        },
      ],
      apps: [
        {
          id: "app-1",
          slug: "sales-dashboard",
          name: "Sales Dashboard",
          description: "Reusable sales reporting app.",
          ownerUserId: "user-1",
          status: "deployed",
          liveArtifactId: "artifact-1",
        },
      ],
      now: NOW,
    });

    expect(recommendationInputsFromCapabilityGraph(graph)).toMatchObject({
      connectedProviders: ["github"],
      approvedProviders: ["github"],
      skills: [
        {
          id: "skill-1",
          name: "Weekly PR Summary",
          mcpProviders: ["github"],
          runnableNow: true,
          sharedWithMe: true,
        },
      ],
      apps: [
        {
          id: "app-1",
          name: "Sales Dashboard",
          slug: "sales-dashboard",
          runnableNow: true,
          sharedWithMe: false,
        },
      ],
    });
  });
});

function emptyProviders() {
  return {
    connectedProviders: [],
    allowedProviders: [],
    deniedProviders: [],
  };
}
