import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const isMcpProviderExecutionConfigured = vi.fn();
vi.mock("@/lib/oauth/mcp-servers", () => ({ isMcpProviderExecutionConfigured }));

/** Fluent stub: each `.limit()` pops the next catalog row set. */
function catalogDb(rowSets: Array<Array<Record<string, unknown>>>) {
  const queue = [...rowSets];
  return {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => queue.shift() ?? [] }),
      }),
    }),
  } as never;
}

const readTool = { enabled: true, action: "read", policy: "always_allow" };
const soql = {
  id: "pipeline",
  provider: "salesforce",
  toolName: "run_soql",
  pinnedArgs: { soql: "SELECT Id FROM Opportunity" },
};
const issues = {
  id: "issues",
  provider: "github",
  toolName: "list_issues",
  pinnedArgs: { owner: "o", repo: "r" },
};

beforeEach(() => {
  vi.clearAllMocks();
  isMcpProviderExecutionConfigured.mockReturnValue(true);
});
afterEach(() => vi.resetModules());

describe("checkLiveBindingsPublishable", () => {
  it("passes when every binding targets an enabled always-allowed read tool on a supported provider", async () => {
    const { checkLiveBindingsPublishable } = await import("@/lib/app-binding-gate");
    const result = await checkLiveBindingsPublishable(
      catalogDb([[readTool], [readTool]]),
      [soql, issues],
    );
    expect(result).toEqual({ ok: true });
    expect(isMcpProviderExecutionConfigured).toHaveBeenCalledWith("salesforce");
    expect(isMcpProviderExecutionConfigured).toHaveBeenCalledWith("github");
  });

  it("fails closed on the first binding whose tool is a write, disabled, or uncataloged", async () => {
    const { checkLiveBindingsPublishable } = await import("@/lib/app-binding-gate");
    expect(
      await checkLiveBindingsPublishable(
        catalogDb([[readTool], [{ ...readTool, action: "write" }]]),
        [soql, issues],
      ),
    ).toMatchObject({ ok: false, bindingId: "issues", reason: "tool_not_read_only" });
    expect(
      await checkLiveBindingsPublishable(catalogDb([[], [readTool]]), [soql, issues]),
    ).toMatchObject({ ok: false, bindingId: "pipeline", reason: "tool_not_cataloged" });
  });

  it("refuses a provider this deployment cannot execute or that lacks viewer identity", async () => {
    const { checkLiveBindingsPublishable } = await import("@/lib/app-binding-gate");
    isMcpProviderExecutionConfigured.mockReturnValue(false);
    expect(
      await checkLiveBindingsPublishable(catalogDb([[readTool]]), [issues]),
    ).toMatchObject({ ok: false, reason: "provider_execution_unavailable" });

    isMcpProviderExecutionConfigured.mockReturnValue(true);
    const result = await checkLiveBindingsPublishable(catalogDb([[readTool]]), [
      { ...issues, provider: "data-lake" },
    ]);
    expect(result).toMatchObject({ ok: false, reason: "provider_not_viewer_identity" });
    expect(result.ok ? "" : result.message).toContain("Publish this version as a snapshot");
  });

  it("looks each catalog key up once even when bindings share a tool", async () => {
    const { checkLiveBindingsPublishable } = await import("@/lib/app-binding-gate");
    // Only one row set is provided; a second lookup would find [] and fail.
    const result = await checkLiveBindingsPublishable(catalogDb([[readTool]]), [
      soql,
      { ...soql, id: "pipeline-2" },
    ]);
    expect(result).toEqual({ ok: true });
  });
});
