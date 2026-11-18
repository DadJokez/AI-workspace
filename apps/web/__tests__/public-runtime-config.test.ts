import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PUBLIC_RUNTIME_CONFIG_ELEMENT_ID,
  readPublicRuntimeConfig,
  serializePublicRuntimeConfig,
} from "@/lib/public-runtime-config";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("public runtime config", () => {
  it("round-trips through the page element", () => {
    const config = {
      analytics: {
        provider: "posthog" as const,
        token: "phc_test",
        apiHost: "/ingest",
      },
      connectors: ["github", "salesforce"],
    };
    const getElementById = vi.fn(() => ({
      textContent: serializePublicRuntimeConfig(config),
    }));
    vi.stubGlobal("document", { getElementById });

    expect(readPublicRuntimeConfig()).toEqual(config);
    expect(getElementById).toHaveBeenCalledWith(PUBLIC_RUNTIME_CONFIG_ELEMENT_ID);
  });

  it("cannot close its own script element", () => {
    const serialized = serializePublicRuntimeConfig({
      analytics: {
        provider: "posthog",
        token: "</script><script>alert(1)</script>",
        apiHost: "/ingest",
      },
      connectors: [],
    });
    expect(serialized).not.toContain("<");
    expect(JSON.parse(serialized).analytics.token).toBe(
      "</script><script>alert(1)</script>",
    );
  });

  it("is null on the server and when the element is missing or malformed", () => {
    expect(readPublicRuntimeConfig()).toBeNull();
    vi.stubGlobal("document", { getElementById: () => null });
    expect(readPublicRuntimeConfig()).toBeNull();
    vi.stubGlobal("document", {
      getElementById: () => ({ textContent: "{not json" }),
    });
    expect(readPublicRuntimeConfig()).toBeNull();
  });
});
