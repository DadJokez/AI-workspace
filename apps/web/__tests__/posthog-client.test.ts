import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const posthog = vi.hoisted(() => ({
  init: vi.fn(),
}));

vi.mock("posthog-js", () => ({
  default: {
    init: posthog.init,
  },
}));

const originalToken = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;

describe("PostHog browser instrumentation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN = "phc_test";
  });

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
    } else {
      process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN = originalToken;
    }
    vi.restoreAllMocks();
  });

  it("captures page and explicit product events without page content", async () => {
    await import("../instrumentation-client");

    expect(posthog.init).toHaveBeenCalledWith(
      "phc_test",
      expect.objectContaining({
        api_host: "/ingest",
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: false,
        capture_exceptions: false,
        disable_session_recording: true,
        person_profiles: "identified_only",
      }),
    );
  });

  it("does not initialize without a project token", async () => {
    delete process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await import("../instrumentation-client");

    expect(posthog.init).not.toHaveBeenCalled();
  });
});
