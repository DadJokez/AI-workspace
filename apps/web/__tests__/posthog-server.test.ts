import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const posthog = vi.hoisted(() => ({
  capture: vi.fn(),
  construct: vi.fn(),
  on: vi.fn(),
}));

vi.mock("posthog-node", () => ({
  PostHog: function MockPostHog(
    token: string,
    options: Record<string, unknown>,
  ) {
    posthog.construct(token, options);
    return {
      capture: posthog.capture,
      on: posthog.on,
    };
  },
}));

async function loadCapture() {
  const module = await import("@/lib/posthog-server");
  return module.capturePostHogEvent;
}

describe("capturePostHogEvent", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("ANALYTICS_PROVIDER", "posthog");
    vi.stubEnv("POSTHOG_PROJECT_TOKEN", "phc_test");
    vi.stubEnv("POSTHOG_HOST", "https://analytics.example.test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reuses one non-blocking client across captures", async () => {
    const capture = await loadCapture();

    capture({
      distinctId: "user-1",
      event: "chat_turn_submitted",
      properties: { has_attachments: false },
    });
    capture({
      distinctId: "user-1",
      event: "feedback_report_submitted",
    });

    expect(posthog.construct).toHaveBeenCalledOnce();
    expect(posthog.construct).toHaveBeenCalledWith("phc_test", {
      host: "https://analytics.example.test",
      flushAt: 1,
      flushInterval: 0,
    });
    expect(posthog.capture).toHaveBeenCalledTimes(2);
    expect(posthog.capture).toHaveBeenNthCalledWith(1, {
      distinctId: "user-1",
      event: "chat_turn_submitted",
      properties: { has_attachments: false },
    });
  });

  it("builds no client and sends nothing when analytics is off", async () => {
    vi.stubEnv("ANALYTICS_PROVIDER", "none");
    const capture = await loadCapture();

    capture({ distinctId: "user-1", event: "chat_turn_submitted" });

    expect(posthog.construct).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it("is off by default, even with a token present", async () => {
    vi.stubEnv("ANALYTICS_PROVIDER", "");
    const capture = await loadCapture();

    capture({ distinctId: "user-1", event: "chat_turn_submitted" });

    expect(posthog.construct).not.toHaveBeenCalled();
  });

  it("never lets analytics failures break the product action", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    posthog.capture.mockImplementationOnce(() => {
      throw new Error("analytics unavailable");
    });
    const capture = await loadCapture();

    expect(() =>
      capture({
        distinctId: "user-1",
        event: "app_version_deployed",
      }),
    ).not.toThrow();
    expect(error).toHaveBeenCalledWith(
      "[posthog] failed to capture app_version_deployed",
      expect.any(Error),
    );
  });
});
