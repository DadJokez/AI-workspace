import { describe, expect, it } from "vitest";
import { filterAttestedProviders } from "@/lib/tool-attestations";

describe("filterAttestedProviders", () => {
  const catalog = [
    {
      id: "tool_repo_read",
      provider: "github",
      toolName: "get_file_contents",
      category: "repos",
      action: "read" as const,
      requiresAttestation: true,
      enabled: true,
    },
    {
      id: "tool_repo_write",
      provider: "github",
      toolName: "create_or_update_file",
      category: "repos",
      action: "write" as const,
      requiresAttestation: true,
      enabled: true,
    },
    {
      id: "tool_disabled",
      provider: "github",
      toolName: "delete_file",
      category: "repos",
      action: "write" as const,
      requiresAttestation: true,
      enabled: false,
    },
  ];

  it("allows providers with active provider-scope attestations", () => {
    expect(
      filterAttestedProviders(["github"], [
        {
          provider: "github",
          scopeType: "provider",
          category: null,
          toolName: null,
          action: "admin",
        },
      ]),
    ).toEqual({
      allowedProviders: ["github"],
      deniedProviders: [],
      toolPolicies: { github: {} },
    
      toolActions: {},
    });
  });

  it("denies connected providers without provider-scope approval", () => {
    expect(filterAttestedProviders(["github"], [])).toEqual({
      allowedProviders: [],
      deniedProviders: ["github"],
      toolPolicies: {},
      toolActions: {},
    });
  });

  it("mounts only catalog-approved tools for category or tool attestations", () => {
    expect(
      filterAttestedProviders(
        ["github"],
        [
          {
            provider: "github",
            scopeType: "tool",
            category: null,
            toolName: "list_pull_requests",
            action: "read",
          },
          {
            provider: "github",
            scopeType: "category",
            category: "repos",
            toolName: null,
            action: "read",
          },
        ],
        catalog,
      ),
    ).toEqual({
      allowedProviders: ["github"],
      deniedProviders: [],
      toolPolicies: {
        github: {
          allowedTools: ["get_file_contents"],
          blockedTools: ["delete_file"],
        },
      },
      toolActions: {
        github__get_file_contents: "read",
        github__create_or_update_file: "write",
        github__delete_file: "write",
      },
    });
  });

  it("requires sufficient action level and never exposes disabled catalog tools", () => {
    expect(
      filterAttestedProviders(
        ["github"],
        [
          {
            provider: "github",
            scopeType: "provider",
            category: null,
            toolName: null,
            action: "write",
          },
        ],
        catalog,
      ),
    ).toEqual({
      allowedProviders: ["github"],
      deniedProviders: [],
      toolPolicies: {
        github: {
          allowedTools: ["create_or_update_file", "get_file_contents"],
          blockedTools: ["delete_file"],
        },
      },
      toolActions: {
        github__get_file_contents: "read",
        github__create_or_update_file: "write",
        github__delete_file: "write",
      },
    });
  });

  it("keeps broad admin provider approvals broad while blocking disabled tools", () => {
    expect(
      filterAttestedProviders(
        ["github"],
        [
          {
            provider: "github",
            scopeType: "provider",
            category: null,
            toolName: null,
            action: "admin",
          },
        ],
        catalog,
      ),
    ).toEqual({
      allowedProviders: ["github"],
      deniedProviders: [],
      toolPolicies: { github: { blockedTools: ["delete_file"] } },
      toolActions: {
        github__get_file_contents: "read",
        github__create_or_update_file: "write",
        github__delete_file: "write",
      },
    });
  });

  it("denies non-attested catalog tools until the provider is attested", () => {
    expect(
      filterAttestedProviders(
        ["github"],
        [],
        [
          {
            id: "tool_public_context",
            provider: "github",
            toolName: "get_me",
            category: "context",
            action: "read",
            requiresAttestation: false,
            enabled: true,
          },
        ],
      ),
    ).toEqual({
      allowedProviders: [],
      deniedProviders: ["github"],
      toolPolicies: {},
      toolActions: { github__get_me: "read" },
    });
  });

  it("allows non-attested catalog tools after provider attestation", () => {
    expect(
      filterAttestedProviders(
        ["github"],
        [
          {
            provider: "github",
            scopeType: "provider",
            category: null,
            toolName: null,
            action: "read",
          },
        ],
        [
          {
            id: "tool_public_context",
            provider: "github",
            toolName: "get_me",
            category: "context",
            action: "read",
            requiresAttestation: false,
            enabled: true,
          },
        ],
      ),
    ).toEqual({
      allowedProviders: ["github"],
      deniedProviders: [],
      toolPolicies: { github: { allowedTools: ["get_me"] } },
      toolActions: { github__get_me: "read" },
    });
  });

  it("does not expose non-attested write tools to read-only provider approvals", () => {
    expect(
      filterAttestedProviders(
        ["github"],
        [
          {
            provider: "github",
            scopeType: "provider",
            category: null,
            toolName: null,
            action: "read",
          },
        ],
        [
          {
            id: "tool_context_read",
            provider: "github",
            toolName: "get_me",
            category: "context",
            action: "read",
            requiresAttestation: false,
            enabled: true,
          },
          {
            id: "tool_context_write",
            provider: "github",
            toolName: "update_profile",
            category: "context",
            action: "write",
            requiresAttestation: false,
            enabled: true,
          },
        ],
      ),
    ).toEqual({
      allowedProviders: ["github"],
      deniedProviders: [],
      toolPolicies: { github: { allowedTools: ["get_me"] } },
      toolActions: {
        github__get_me: "read",
        github__update_profile: "write",
      },
    });
  });
});
