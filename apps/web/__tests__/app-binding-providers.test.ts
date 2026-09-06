import { describe, expect, it } from "vitest";
import {
  VIEWER_IDENTITY_BINDING_PROVIDERS,
  describeBindingGateReason,
  evaluateBindingGate,
  isReadOnlyCatalogEntry,
  providerSupportsViewerIdentity,
} from "@/lib/app-binding-providers";
import { INTEGRATION_DISPLAY_NAMES } from "@/lib/settings-navigation";

const readTool = {
  enabled: true,
  action: "read" as const,
  policy: "always_allow" as const,
};

describe("viewer-identity provider gate", () => {
  it("only admits providers with per-user credentials, a connect CTA, and audit", () => {
    for (const [provider, support] of Object.entries(
      VIEWER_IDENTITY_BINDING_PROVIDERS,
    )) {
      expect(support, provider).toEqual({
        perUserCredential: true,
        connectCta: true,
        audit: true,
      });
      expect(providerSupportsViewerIdentity(provider)).toBe(true);
      // The connect CTA claim must be backed by a real Settings card.
      expect(
        INTEGRATION_DISPLAY_NAMES[
          provider as keyof typeof INTEGRATION_DISPLAY_NAMES
        ],
        `${provider} has no Settings → Integrations card`,
      ).toBeTruthy();
    }
  });

  it("fails closed for providers outside the table (service-principal sources)", () => {
    expect(providerSupportsViewerIdentity("data-lake")).toBe(false);
    expect(providerSupportsViewerIdentity("databricks")).toBe(false);
    expect(providerSupportsViewerIdentity("")).toBe(false);
  });
});

describe("isReadOnlyCatalogEntry", () => {
  it("accepts only enabled, always-allowed read tools", () => {
    expect(isReadOnlyCatalogEntry(readTool)).toBe(true);
    expect(isReadOnlyCatalogEntry(null)).toBe(false);
    expect(isReadOnlyCatalogEntry(undefined)).toBe(false);
    expect(isReadOnlyCatalogEntry({ ...readTool, enabled: false })).toBe(false);
    expect(isReadOnlyCatalogEntry({ ...readTool, action: "write" })).toBe(false);
    expect(isReadOnlyCatalogEntry({ ...readTool, action: "admin" })).toBe(false);
    expect(
      isReadOnlyCatalogEntry({ ...readTool, policy: "needs_approval" }),
    ).toBe(false);
    expect(isReadOnlyCatalogEntry({ ...readTool, policy: "blocked" })).toBe(false);
  });
});

describe("evaluateBindingGate", () => {
  const binding = { id: "b1", provider: "github", toolName: "list_issues" };

  it("passes an eligible provider with a configured endpoint and a read tool", () => {
    expect(
      evaluateBindingGate(binding, {
        catalogEntry: readTool,
        executionConfigured: true,
      }),
    ).toBeNull();
  });

  it("reports the most fundamental problem first", () => {
    expect(
      evaluateBindingGate(
        { ...binding, provider: "data-lake" },
        { catalogEntry: readTool, executionConfigured: true },
      ),
    ).toBe("provider_not_viewer_identity");
    expect(
      evaluateBindingGate(binding, {
        catalogEntry: readTool,
        executionConfigured: false,
      }),
    ).toBe("provider_execution_unavailable");
    expect(
      evaluateBindingGate(binding, {
        catalogEntry: null,
        executionConfigured: true,
      }),
    ).toBe("tool_not_cataloged");
    expect(
      evaluateBindingGate(binding, {
        catalogEntry: { ...readTool, action: "write" },
        executionConfigured: true,
      }),
    ).toBe("tool_not_read_only");
  });

  it("describes every reason with the binding target and a next step", () => {
    for (const reason of [
      "provider_not_viewer_identity",
      "provider_execution_unavailable",
      "tool_not_cataloged",
      "tool_not_read_only",
    ] as const) {
      const message = describeBindingGateReason(binding, reason);
      expect(message).toContain('github/list_issues (binding "b1")');
      expect(message).toContain("cannot be published live");
    }
  });
});
