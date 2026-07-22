import { describe, expect, it, vi } from "vitest";
import {
  AGENTCORE_WORKLOAD_ACCESS_TOKEN_HEADER,
  createAgentCoreApiKeyProvider,
  readWorkloadAccessToken,
} from "./agentcore-api-key";

describe("AgentCore API-key credential resolution", () => {
  it("reads the Runtime-provided workload token header", () => {
    expect(AGENTCORE_WORKLOAD_ACCESS_TOKEN_HEADER).toBe("WorkloadAccessToken");
    expect(
      readWorkloadAccessToken({ workloadaccesstoken: "  workload-token  " }),
    ).toBe("workload-token");
    expect(
      readWorkloadAccessToken({ workloadaccesstoken: ["first", "second"] }),
    ).toBe("first");
  });

  it("retrieves the provider key lazily and only once per invocation", async () => {
    const send = vi.fn(async (_command: unknown) => ({
      apiKey: "  brave-secret  ",
    }));
    const provide = createAgentCoreApiKeyProvider({
      workloadAccessToken: "workload-token",
      providerName: "comparative-brave-search",
      client: { send } as never,
    });

    expect(send).not.toHaveBeenCalled();
    await expect(Promise.all([provide(), provide()])).resolves.toEqual([
      "brave-secret",
      "brave-secret",
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]![0] as {
      input: Record<string, unknown>;
    };
    expect(command.input).toEqual({
      workloadIdentityToken: "workload-token",
      resourceCredentialProviderName: "comparative-brave-search",
    });
  });

  it("retries a transient credential lookup, then caches the success", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary identity outage"))
      .mockResolvedValue({ apiKey: "recovered-key" });
    const provide = createAgentCoreApiKeyProvider({
      workloadAccessToken: "workload-token",
      providerName: "comparative-brave-search",
      client: { send } as never,
    });

    await expect(provide()).rejects.toThrow(/temporarily unavailable/i);
    await expect(provide()).resolves.toBe("recovered-key");
    await expect(provide()).resolves.toBe("recovered-key");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("fails honestly before calling AWS when Runtime omitted the token", async () => {
    const send = vi.fn();
    const provide = createAgentCoreApiKeyProvider({
      providerName: "comparative-brave-search",
      client: { send } as never,
    });

    await expect(provide()).rejects.toThrow(/workload identity token is missing/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("does not leak AWS credential errors into the tool result", async () => {
    const provide = createAgentCoreApiKeyProvider({
      workloadAccessToken: "workload-token",
      providerName: "comparative-brave-search",
      client: {
        send: async () => {
          throw new Error("provider-error-sensitive-detail");
        },
      } as never,
    });

    await expect(provide()).rejects.toThrow(
      "AgentCore web-search credential retrieval failed. Search is temporarily unavailable.",
    );
    await expect(provide()).rejects.not.toThrow(/sensitive-detail/);
  });
});
