import { describe, expect, it } from "vitest";
import { resolveChatMcpProviderScope } from "@/lib/chat-mcp-provider-scope";

describe("chat MCP provider scope", () => {
  it("keeps account tool status unfiltered for a no-tool activated skill", () => {
    const scope = resolveChatMcpProviderScope([]);

    expect(scope.accountStatusOptions).toBeUndefined();
    expect(scope.mountOptions).toEqual({ onlyProviders: [] });
  });

  it("only scopes MCP mounting for a provider-backed activated skill", () => {
    const scope = resolveChatMcpProviderScope(["github"]);

    expect(scope.accountStatusOptions).toBeUndefined();
    expect(scope.mountOptions).toEqual({ onlyProviders: ["github"] });
  });

  it("leaves both status and mounting unscoped for ordinary chat turns", () => {
    const scope = resolveChatMcpProviderScope(undefined);

    expect(scope.accountStatusOptions).toBeUndefined();
    expect(scope.mountOptions).toBeUndefined();
  });
});
