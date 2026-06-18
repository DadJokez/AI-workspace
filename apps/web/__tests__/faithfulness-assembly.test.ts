import { describe, expect, it } from "vitest";
import { buildCapabilityGraph } from "@/lib/capability-graph";
import { buildChatContextPack } from "@/lib/chat-context-pack";
import {
  buildChatRouteReceipt,
  decideChatRuntimeRoute,
} from "@/lib/chat-routing";
import {
  buildRecommendationCandidates,
  type RecommendationCandidate,
} from "@/lib/recommendations";

describe("faithfulness harness assembly", () => {
  it("assembles route, context, and recommendations from the same capability graph", () => {
    const capabilityGraph = buildCapabilityGraph({
      userId: "user-1",
      providerStatus: {
        connectedProviders: ["github"],
        allowedProviders: ["github"],
        deniedProviders: [],
      },
      mountedProviders: [],
      skills: [
        {
          id: "skill-1",
          slug: "weekly-status",
          name: "Weekly Status Writer",
          description: "Write weekly status updates from notes.",
          ownerUserId: "user-1",
          isStarter: false,
          mcpProviders: ["github"],
        },
      ],
      apps: [
        {
          id: "app-1",
          slug: "launch-dashboard",
          name: "Launch Dashboard",
          description: "Reusable launch dashboard.",
          ownerUserId: "user-1",
          status: "deployed",
          liveArtifactId: "artifact-live",
        },
      ],
      schedules: [
        {
          id: "schedule-1",
          skillId: "skill-1",
          skillName: "Weekly Status Writer",
          cadence: "weekly",
          timezone: "America/New_York",
          enabled: true,
          nextRunAt: "2026-06-19T13:00:00.000Z",
        },
      ],
    });
    const route = decideChatRuntimeRoute({
      message: "What should I tackle first?",
      runtimeV2: true,
      capabilityGraph,
    });
    const routeReceipt = buildChatRouteReceipt({
      route,
      contextSignals: { priorUserMessagesCount: 2 },
      capabilityGraph,
    });
    const recommendations = buildRecommendationCandidates({
      currentMessage:
        "What skills should I use or save to draft the weekly status update again and keep this dashboard reusable?",
      recentUserMessages: [
        "Draft the weekly status update from these notes.",
        "Can you draft the weekly status update again?",
      ],
      connectedProviders: ["github"],
      approvedProviders: ["github"],
      skills: [
        {
          id: "skill-1",
          name: "Weekly Status Writer",
          description: "Write weekly status updates from notes.",
          mcpProviders: ["github"],
          runnableNow: true,
        },
      ],
      apps: [
        {
          id: "app-1",
          name: "Launch Dashboard",
          description: "Reusable launch dashboard.",
          slug: "launch-dashboard",
          runnableNow: true,
        },
      ],
      artifacts: [
        {
          id: "artifact-1",
          title: "Launch Dashboard",
          filename: "launch-dashboard.html",
          kind: "html",
          mimeType: "text/html",
        },
      ],
    });
    const pack = buildChatContextPack({
      user: {
        displayName: "Rob",
        assistantName: "Thomas",
        customInstructions: null,
      },
      messages: [
        { role: "user", content: "What should I tackle first?" },
      ],
      threadSummary: "Earlier: Rob asked for a weekly status workflow.",
      vaultMarkdown: "# Personal Context\n- Rob is evaluating Comparative.",
      vaultContextRequested: route.includeVaultContext,
      providerStatus: {
        connectedProviders: ["github"],
        allowedProviders: ["github"],
        deniedProviders: [],
      },
      mountedProviders: [],
      capabilityGraph,
      route,
      recommendations,
      now: new Date("2026-06-17T00:00:00.000Z"),
    });

    expect(route).toMatchObject({
      lane: "tool-local",
      useMcp: true,
      reasons: ["capability_graph_github_work_lookup"],
    });
    expect(routeReceipt).toMatchObject({
      toolAvailability: {
        connectedProviders: ["github"],
        approvedProviders: ["github"],
      },
      capabilityAvailability: {
        providers: 1,
        skills: 1,
        apps: 1,
        schedules: 1,
        runnableNow: 4,
      },
    });
    expect(pack.receipts[0]).toMatchObject({
      route: {
        lane: "tool-local",
        useMcp: true,
      },
      capabilities: {
        providers: 1,
        skills: 1,
        apps: 1,
        schedules: 1,
      },
      recommendations: {
        save_as_skill: 0,
        run_existing_skill: 1,
        open_existing_app: 1,
      },
    });
    expect(pack.prompt.systemPrompt).toContain("Context receipt for this turn");
    expect(pack.prompt.systemPrompt).toContain("Routing: Mounted local tools");
    expect(pack.prompt.systemPrompt).toContain("Capability graph summary");
    expect(recommendationTypes(recommendations)).toEqual(
      expect.arrayContaining([
        "run_existing_skill",
        "open_existing_app",
      ]),
    );
  });
});

function recommendationTypes(
  recommendations: readonly RecommendationCandidate[],
): string[] {
  return recommendations.map((candidate) => candidate.type);
}
