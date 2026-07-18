import { describe, expect, it } from "vitest";
import {
  observedPolicyDecision,
  resolveToolPolicy,
  toolActionKey,
} from "@/lib/tool-policy";
import { buildToolAuditRows } from "@/lib/audit-tool-events";
import { filterAttestedProviders } from "@/lib/tool-attestations";

describe("resolveToolPolicy (#410 action-level defaults)", () => {
  it("maps the three action levels deterministically", () => {
    expect(resolveToolPolicy("read")).toBe("always_allow");
    expect(resolveToolPolicy("write")).toBe("needs_approval");
    expect(resolveToolPolicy("admin")).toBe("blocked");
  });

  it("fails toward caution on unknown actions", () => {
    expect(resolveToolPolicy(undefined)).toBe("needs_approval");
  });
});

describe("observedPolicyDecision", () => {
  it("uses would_* naming so observation cannot read as enforcement", () => {
    expect(observedPolicyDecision("read")).toBe("auto_allowed");
    expect(observedPolicyDecision("write")).toBe("would_need_approval");
    expect(observedPolicyDecision("admin")).toBe("would_block");
    expect(observedPolicyDecision(undefined)).toBe(
      "uncataloged_would_need_approval",
    );
  });
});

describe("filterAttestedProviders toolActions surface", () => {
  it("exposes the catalog action per provider__tool key", () => {
    const result = filterAttestedProviders(
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
      [
        {
          id: "t1",
          provider: "github",
          toolName: "list_pull_requests",
          category: "repos",
          action: "read",
          requiresAttestation: true,
          enabled: true,
        },
        {
          id: "t2",
          provider: "github",
          toolName: "create_issue",
          category: "repos",
          action: "write",
          requiresAttestation: true,
          enabled: true,
        },
      ],
    );
    expect(result.toolActions).toEqual({
      github__list_pull_requests: "read",
      github__create_issue: "write",
    });
  });

  it("returns an empty map with no catalog", () => {
    expect(filterAttestedProviders([], [], []).toolActions).toEqual({});
  });
});

describe("buildToolAuditRows policy stamping (observe mode)", () => {
  const baseInput = {
    actorUserId: "user-1",
    chatThreadId: "thread-1",
    chatMessageId: "msg-1",
    runId: "run-1",
    modelId: "sonnet-4-6",
    runtime: "bedrock-agent",
  };
  const call = (name: string, provider: string, toolName: string) => ({
    id: `call-${toolName}`,
    name,
    provider,
    toolName,
    input: {},
    startedAt: new Date().toISOString(),
  });

  it("stamps per-tool decisions from the actions map", () => {
    const rows = buildToolAuditRows({
      ...baseInput,
      calls: [
        call("github__list_pull_requests", "github", "list_pull_requests"),
        call("github__create_issue", "github", "create_issue"),
        call("github__ghost_tool", "github", "ghost_tool"),
      ],
      results: [],
      toolActions: {
        [toolActionKey("github", "list_pull_requests")]: "read",
        [toolActionKey("github", "create_issue")]: "write",
      },
    });
    expect(rows.map((row) => row.metadata.policyDecision)).toEqual([
      "auto_allowed",
      "would_need_approval",
      "uncataloged_would_need_approval",
    ]);
  });

  it("omits the stamp entirely when no actions map is supplied", () => {
    const rows = buildToolAuditRows({
      ...baseInput,
      calls: [call("github__list_pull_requests", "github", "list_pull_requests")],
      results: [],
    });
    expect(rows[0]!.metadata.policyDecision).toBeUndefined();
  });
});
