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

const originalToken = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
const originalHost = process.env.NEXT_PUBLIC_POSTHOG_HOST;

async function loadCapture() {
  const module = await import("@/lib/posthog-server");
  return module.capturePostHogEvent;
}

describe("capturePostHogEvent", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN = "phc_test";
    process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://analytics.example.test";
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalToken === undefined) {
      delete process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
    } else {
      process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN = originalToken;
    }
    if (originalHost === undefined) {
      delete process.env.NEXT_PUBLIC_POSTHOG_HOST;
    } else {
      process.env.NEXT_PUBLIC_POSTHOG_HOST = originalHost;
    }
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

  it("is a no-op when analytics is not configured", async () => {
    vi.stubEnv("NODE_ENV", "development");
    delete process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const capture = await loadCapture();

    capture({ distinctId: "user-1", event: "chat_turn_submitted" });
    capture({ distinctId: "user-1", event: "chat_turn_submitted" });

    expect(posthog.construct).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
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
