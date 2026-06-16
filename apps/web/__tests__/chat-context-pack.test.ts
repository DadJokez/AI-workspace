import { describe, expect, it } from "vitest";
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

    expect(pack.receipts[0]?.vault).toEqual({
      checked: true,
      injected: false,
      approvedMemoryChars: 0,
    });
    expect(pack.prompt.systemPrompt).toContain("no approved Vault memory was available");
  });

  it("records approved Vault memory as injected and renders it into the prompt", () => {
    const pack = buildChatContextPack({
      ...baseInput(),
      vaultContextRequested: true,
      vaultMarkdown: "# Personal Context\n- Rob prefers direct progress.",
    });

    expect(pack.receipts[0]?.vault.injected).toBe(true);
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
    expect(pack.prompt.systemPrompt).toContain("uploaded files brief.csv");
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
