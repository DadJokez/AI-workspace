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
      policy: "always_allow" as const,
      requiresAttestation: true,
      enabled: true,
    },
    {
      id: "tool_repo_write",
      provider: "github",
      toolName: "create_or_update_file",
      category: "repos",
      action: "write" as const,
      policy: "needs_approval" as const,
      requiresAttestation: true,
      enabled: true,
    },
    {
      id: "tool_disabled",
      provider: "github",
      toolName: "delete_file",
      category: "repos",
      action: "write" as const,
      policy: "blocked" as const,
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
      toolPolicyDecisions: {},
    });
  });

  it("denies connected providers without provider-scope approval", () => {
    expect(filterAttestedProviders(["github"], [])).toEqual({
      allowedProviders: [],
      deniedProviders: ["github"],
      toolPolicies: {},
      toolPolicyDecisions: {},
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
      toolPolicyDecisions: {
        github__get_file_contents: "always_allow",
        github__create_or_update_file: "needs_approval",
        github__delete_file: "blocked",
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
      toolPolicyDecisions: {
        github__get_file_contents: "always_allow",
        github__create_or_update_file: "needs_approval",
        github__delete_file: "blocked",
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
      toolPolicyDecisions: {
        github__get_file_contents: "always_allow",
        github__create_or_update_file: "needs_approval",
        github__delete_file: "blocked",
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
            policy: "always_allow",
            requiresAttestation: false,
            enabled: true,
          },
        ],
      ),
    ).toEqual({
      allowedProviders: [],
      deniedProviders: ["github"],
      toolPolicies: {},
      toolPolicyDecisions: { github__get_me: "always_allow" },
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
            policy: "always_allow",
            requiresAttestation: false,
            enabled: true,
          },
        ],
      ),
    ).toEqual({
      allowedProviders: ["github"],
      deniedProviders: [],
      toolPolicies: { github: { allowedTools: ["get_me"] } },
      toolPolicyDecisions: { github__get_me: "always_allow" },
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
            policy: "always_allow",
            requiresAttestation: false,
            enabled: true,
          },
          {
            id: "tool_context_write",
            provider: "github",
            toolName: "update_profile",
            category: "context",
            action: "write",
            policy: "needs_approval",
            requiresAttestation: false,
            enabled: true,
          },
        ],
      ),
    ).toEqual({
      allowedProviders: ["github"],
      deniedProviders: [],
      toolPolicies: { github: { allowedTools: ["get_me"] } },
      toolPolicyDecisions: {
        github__get_me: "always_allow",
        github__update_profile: "needs_approval",
      },
    });
  });
});
