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
    expect(observedPolicyDecision("always_allow")).toBe("auto_allowed");
    expect(observedPolicyDecision("needs_approval")).toBe(
      "would_need_approval",
    );
    expect(observedPolicyDecision("blocked")).toBe("would_block");
    expect(observedPolicyDecision(undefined)).toBe(
      "uncataloged_would_need_approval",
    );
  });
});

describe("filterAttestedProviders policy surface", () => {
  it("exposes persisted policy per provider__tool key", () => {
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
          policy: "always_allow",
          requiresAttestation: true,
          enabled: true,
        },
        {
          id: "t2",
          provider: "github",
          toolName: "create_issue",
          category: "repos",
          action: "write",
          policy: "blocked",
          requiresAttestation: true,
          enabled: true,
        },
      ],
    );
    expect(result.toolPolicyDecisions).toEqual({
      github__list_pull_requests: "always_allow",
      github__create_issue: "blocked",
    });
  });

  it("returns an empty map with no catalog", () => {
    expect(filterAttestedProviders([], [], []).toolPolicyDecisions).toEqual({});
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
      toolPolicyDecisions: {
        [toolActionKey("github", "list_pull_requests")]: "always_allow",
        [toolActionKey("github", "create_issue")]: "needs_approval",
      },
    });
    expect(rows.map((row) => row.policyDecision)).toEqual([
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
    expect(rows[0]!.policyDecision).toBeNull();
  });
});
