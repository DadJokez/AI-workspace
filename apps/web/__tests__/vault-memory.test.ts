import { describe, expect, it } from "vitest";
import { buildAgentPreamble } from "@/lib/agent-preamble";
import {
  buildVaultMarkdown,
  normalizeMemoryCategory,
  serializeMemoryItem,
} from "@/lib/vault-memory";

describe("vault memory", () => {
  it("renders approved memory as grouped markdown", () => {
    const markdown = buildVaultMarkdown([
      memoryItem({
        category: "working_style",
        title: "Visible progress",
        bodyMd: "Prefers direct, iterative progress.",
      }),
      memoryItem({
        category: "current_priorities",
        title: "Vault capture",
        bodyMd: "- Build governed Vault memory capture.",
      }),
      memoryItem({
        status: "suggested",
        category: "systems",
        title: "GitHub",
        bodyMd: "Uses GitHub for repo work.",
      }),
    ]);

    expect(markdown).toContain("# Personal Context");
    expect(markdown).toContain("## Current Priorities");
    expect(markdown).toContain(
      "- **Vault capture:** Build governed Vault memory capture.",
    );
    expect(markdown).toContain("## Working Style");
    expect(markdown).not.toContain("Uses GitHub");
  });

  it("normalizes loose category labels", () => {
    expect(normalizeMemoryCategory("Working Style")).toBe("working_style");
    expect(normalizeMemoryCategory("")).toBe("personal_context");
  });

  it("surfaces user-grounded provenance without relabeling legacy suggestions", () => {
    const grounded = serializeMemoryItem(
      memoryItem({
        status: "suggested",
        sourceMessageIds: ["message-1"],
        suggestedBy: "memory-capture:user-grounded",
        metadata: {
          provenance: {
            sourceRole: "user",
            sourceMessageIds: ["message-1"],
          },
        },
      }),
    );
    const legacy = serializeMemoryItem(
      memoryItem({
        status: "suggested",
        sourceMessageIds: ["message-2"],
        suggestedBy: "memory-capture",
      }),
    );

    expect(grounded.provenance).toBe("user_stated");
    expect(legacy.provenance).toBe("unverified");
  });

  it("injects approved vault markdown into the agent preamble", () => {
    const preamble = buildAgentPreamble({
      user: {
        displayName: "Rob",
        customInstructions: null,
        vaultMarkdown: "# Personal Context\n\n## Working Style\n- Direct",
      },
      connectedProviders: [],
      vaultContextRequested: true,
    });

    expect(preamble).toContain("Vault access for this turn");
    expect(preamble).toContain("you have access to the user's approved Vault memory");
    expect(preamble).toContain("Do not say you have no access to the Vault");
    expect(preamble).toContain("Personal context approved by the user:");
    expect(preamble).toContain("## Working Style");
  });

  it("says vault was checked when no approved memory is available", () => {
    const preamble = buildAgentPreamble({
      user: {
        displayName: "Rob",
        customInstructions: null,
        vaultMarkdown: null,
      },
      connectedProviders: [],
      vaultContextRequested: true,
    });

    expect(preamble).toContain("Vault access for this turn");
    expect(preamble).toContain("no approved Vault memory was available");
    expect(preamble).toContain("do not claim the product lacks a Vault");
  });
});

function memoryItem(overrides: Partial<Parameters<typeof buildVaultMarkdown>[0][number]>) {
  return {
    id: crypto.randomUUID(),
    userId: "user-uuid",
    status: "approved" as const,
    category: "personal_context",
    title: "Title",
    bodyMd: "Body",
    confidence: 80,
    reason: null,
    sourceThreadId: null,
    sourceMessageIds: [],
    suggestedBy: "memory-capture",
    approvedBy: null,
    approvedAt: new Date("2026-05-21T00:00:00Z"),
    dismissedAt: null,
    archivedAt: null,
    metadata: null,
    createdAt: new Date("2026-05-21T00:00:00Z"),
    updatedAt: new Date("2026-05-21T00:00:00Z"),
    ...overrides,
  };
}
