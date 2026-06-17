import { describe, expect, it } from "vitest";
import { buildCapabilityGraph } from "@/lib/capability-graph";
import { buildChatContextPack } from "@/lib/chat-context-pack";
import type { ChatRuntimeRoute } from "@/lib/chat-routing";
import type { UserMcpProviderStatus } from "@/lib/oauth/mcp-servers";

const NOW = new Date("2026-06-14T00:00:00.000Z");

describe("chat context pack", () => {
  it("records a checked-but-empty Vault receipt without claiming memory was injected", () => {
    const pack = buildChatContextPack({
      ...baseInput(),
      vaultContextRequested: true,
      vaultMarkdown: null,
    });

    expect(pack.receipts[0]?.vault).toMatchObject({
      checked: true,
      injected: false,
      approvedMemoryChars: 0,
      approvedMemoryItems: 0,
    });
    expect(pack.receipts[0]?.contextItems).toContainEqual(
      expect.objectContaining({
        id: "vault:checked-empty",
        source: "user_memory_items.approved",
        owner: "user",
        freshness: "durable",
        visibility: "receipt_only",
        injected: false,
      }),
    );
    expect(pack.prompt.systemPrompt).toContain("no approved Vault memory was available");
  });

  it("records approved Vault memory as injected and renders it into the prompt", () => {
    const pack = buildChatContextPack({
      ...baseInput(),
      vaultContextRequested: true,
      vaultMarkdown: "# Personal Context\n- Rob prefers direct progress.",
    });

    expect(pack.receipts[0]?.vault.injected).toBe(true);
    expect(pack.receipts[0]?.vault.approvedMemoryItems).toBe(1);
    expect(pack.user.vaultMemory[0]).toMatchObject({
      type: "vault_memory",
      source: "user_memory_items.approved",
      owner: "user",
      freshness: "durable",
      visibility: "hidden_prompt",
      injected: true,
    });
    expect(pack.prompt.systemPrompt).toContain("Personal context approved by the user");
    expect(pack.prompt.systemPrompt).toContain("Rob prefers direct progress");
  });

  it("distinguishes a connected tool that is not mounted on the current turn", () => {
    const pack = buildChatContextPack({
      ...baseInput(),
      providerStatus: providerStatus({
        connectedProviders: ["github"],
        allowedProviders: ["github"],
      }),
      mountedProviders: [],
    });

    expect(pack.receipts[0]?.tools).toMatchObject({
      connected: ["github"],
      approved: ["github"],
      mounted: [],
    });
    expect(pack.tools.connected[0]).toMatchObject({
      provider: "github",
      source: "tool_attestations",
      connected: true,
      approved: true,
      mounted: false,
      pendingApproval: false,
      injected: true,
    });
    expect(pack.prompt.systemPrompt).toContain("No connected account tool is mounted");
  });

  it("keeps account tools visible when an activated no-tool skill mounts none", () => {
    const pack = buildChatContextPack({
      ...baseInput(),
      route: route({ reasons: ["activated_skill"] }),
      providerStatus: providerStatus({
        connectedProviders: ["github"],
        allowedProviders: ["github"],
      }),
      mountedProviders: [],
    });

    expect(pack.receipts[0]?.tools).toMatchObject({
      connected: ["github"],
      approved: ["github"],
      mounted: [],
    });
    expect(pack.prompt.systemPrompt).toContain("Connected account tools:");
    expect(pack.prompt.systemPrompt).toContain("GitHub: repositories");
    expect(pack.prompt.systemPrompt).toContain("No connected account tool is mounted");
    expect(pack.prompt.systemPrompt).not.toContain(
      "No external tools are connected yet",
    );
  });

  it("records mounted providers when the tool lane loads MCP servers", () => {
    const pack = buildChatContextPack({
      ...baseInput(),
      route: route({ lane: "tool-local", useMcp: true }),
      providerStatus: providerStatus({
        connectedProviders: ["github"],
        allowedProviders: ["github"],
      }),
      mountedProviders: ["github"],
    });

    expect(pack.receipts[0]?.tools.mounted).toEqual(["github"]);
    expect(pack.prompt.systemPrompt).toContain("Mounted tools for this turn");
  });

  it("records artifact context availability", () => {
    const pack = buildChatContextPack({
      ...baseInput(),
      artifactContext: "The user's saved Workspace artifacts:\n- Roadmap, roadmap.md",
    });

    expect(pack.receipts[0]?.work.artifactContextInjected).toBe(true);
    expect(pack.receipts[0]?.work.artifactContextChars).toBeGreaterThan(0);
    expect(pack.work.artifacts[0]).toMatchObject({
      type: "artifact_context",
      source: "workspace_artifacts",
      owner: "workspace",
      freshness: "durable",
      visibility: "hidden_prompt",
      injected: true,
    });
    expect(pack.prompt.systemPrompt).toContain("Roadmap");
  });

  it("records uploaded files folded into the current prompt", () => {
    const pack = buildChatContextPack({
      ...baseInput(),
      uploadedFiles: [{ name: "brief.csv", sizeBytes: 42 }],
      forcePreamble: true,
    });

    expect(pack.receipts[0]?.work.uploadedFilesInjected).toBe(true);
    expect(pack.receipts[0]?.work.uploadedFiles).toEqual([
      { name: "brief.csv", sizeBytes: 42 },
    ]);
    expect(pack.work.uploadedFiles[0]).toMatchObject({
      type: "uploaded_file",
      label: "brief.csv",
      source: "uploaded_files",
      owner: "user",
      freshness: "current_turn",
      visibility: "hidden_prompt",
      injected: true,
    });
    expect(pack.prompt.systemPrompt).toContain("uploaded files brief.csv");
  });

  it("exposes profile, thread, and message context as auditable items", () => {
    const pack = buildChatContextPack({
      ...baseInput(),
      threadSummary: "Earlier: Rob asked about GitHub access.",
    });

    expect(pack.user.profileFacts).toContainEqual(
      expect.objectContaining({
        id: "user:display-name",
        source: "users.display_name",
        owner: "user",
        freshness: "durable",
        injected: true,
      }),
    );
    expect(pack.work.threadSummary).toMatchObject({
      id: "thread:summary",
      source: "chat_threads.summary",
      owner: "workspace",
      injected: true,
    });
    expect(pack.work.recentMessages).toHaveLength(3);
    expect(pack.receipts[0]?.contextItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "users.display_name" }),
        expect.objectContaining({ source: "chat_threads.summary" }),
        expect.objectContaining({ source: "chat_messages" }),
      ]),
    );
    expect(pack.prompt.systemPrompt).toContain("Context sources:");
  });

  it("buckets recommendation candidates for future capability recommendations", () => {
    const pack = buildChatContextPack({
      ...baseInput(),
      recommendations: [
        {
          id: "tool:github",
          type: "tool",
          title: "Use GitHub",
          reason: "GitHub is connected.",
          requiresApproval: false,
          action: { kind: "connect_tool", provider: "github" },
        },
        {
          id: "run-skill:weekly",
          type: "run_existing_skill",
          title: "Run Weekly Status",
          reason: "Matches this request.",
          requiresApproval: true,
          action: { kind: "run_skill", skillId: "skill-1" },
        },
        {
          id: "open-app:sales",
          type: "open_existing_app",
          title: "Open Sales Dashboard",
          reason: "Existing app.",
          requiresApproval: false,
          action: { kind: "open_app", appId: "app-1" },
        },
        {
          id: "deploy-app:artifact",
          type: "deploy_artifact_as_app",
          title: "Deploy this as an app",
          reason: "Reusable artifact.",
          requiresApproval: true,
          action: { kind: "deploy_app", artifactId: "artifact-1" },
        },
        {
          id: "schedule-skill:weekly",
          type: "schedule_skill",
          title: "Schedule this workflow",
          reason: "Recurring cadence.",
          requiresApproval: true,
          action: { kind: "create_schedule", cadenceHint: "weekly:friday" },
        },
      ],
    });

    expect(pack.recommendations.tools).toHaveLength(1);
    expect(pack.recommendations.skills).toHaveLength(1);
    expect(pack.recommendations.apps).toHaveLength(2);
    expect(pack.recommendations.schedules).toHaveLength(1);
    expect(pack.receipts[0]?.recommendations).toMatchObject({
      tool: 1,
      run_existing_skill: 1,
      open_existing_app: 1,
      deploy_artifact_as_app: 1,
      schedule_skill: 1,
    });
  });

  it("injects a compact capability graph summary into the prompt", () => {
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
          slug: "weekly-pr-summary",
          name: "Weekly PR Summary",
          ownerUserId: "user-1",
          isStarter: false,
          mcpProviders: ["github"],
        },
      ],
      apps: [
        {
          id: "app-1",
          slug: "sales-dashboard",
          name: "Sales Dashboard",
          ownerUserId: "user-1",
          status: "deployed",
          liveArtifactId: "artifact-1",
        },
      ],
      now: NOW,
    });
    const pack = buildChatContextPack({
      ...baseInput(),
      providerStatus: providerStatus({
        connectedProviders: ["github"],
        allowedProviders: ["github"],
      }),
      mountedProviders: [],
      capabilityGraph,
    });

    expect(pack.receipts[0]?.capabilities).toMatchObject({
      providers: 1,
      skills: 1,
      apps: 1,
      schedules: 0,
      runnableNow: 3,
      needsApproval: 0,
      connectedNotMountedProviders: ["GitHub"],
    });
    expect(pack.receipts[0]?.contextItems).toContainEqual(
      expect.objectContaining({
        id: "workspace:capability-graph",
        source: "capability_graph",
        injected: true,
      }),
    );
    expect(pack.prompt.systemPrompt).toContain(
      "Capability graph summary for this user",
    );
    expect(pack.prompt.systemPrompt).toContain("Weekly PR Summary");
    expect(pack.prompt.systemPrompt).toContain("Not mounted on this turn");
  });
});

function baseInput(): Parameters<typeof buildChatContextPack>[0] {
  return {
    user: {
      displayName: "Rob",
      assistantName: "Thomas",
      customInstructions: null,
    },
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hey" },
      { role: "user", content: "what context do you have?" },
    ],
    threadSummary: null,
    vaultMarkdown: null,
    vaultContextRequested: false,
    providerStatus: providerStatus({}),
    mountedProviders: [],
    deniedMcpProviders: [],
    modelId: "haiku-4-5",
    artifactContext: null,
    route: route(),
    now: NOW,
  };
}

function providerStatus(
  partial: Partial<UserMcpProviderStatus>,
): UserMcpProviderStatus {
  return {
    connectedProviders: [],
    allowedProviders: [],
    deniedProviders: [],
    ...partial,
  };
}

function route(partial: Partial<ChatRuntimeRoute> = {}): ChatRuntimeRoute {
  return {
    lane: "fast-local",
    executionMode: "local",
    runtimeTarget: "direct-chat",
    runtimeV2: true,
    useWorker: false,
    useMcp: false,
    includeVaultContext: true,
    reasons: ["personal_context_intent"],
    ...partial,
  };
}
