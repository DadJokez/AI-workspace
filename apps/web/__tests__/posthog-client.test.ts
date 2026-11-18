import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const posthog = vi.hoisted(() => ({
  init: vi.fn(),
}));

vi.mock("posthog-js", () => ({
  default: {
    init: posthog.init,
  },
}));

const getElementById = vi.hoisted(() => vi.fn());

function stubRuntimeConfig(config: unknown) {
  getElementById.mockReturnValue(
    config === undefined ? null : { textContent: JSON.stringify(config) },
  );
  vi.stubGlobal("document", { getElementById });
}

describe("PostHog browser instrumentation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    stubRuntimeConfig({
      analytics: { provider: "posthog", token: "phc_test", apiHost: "/ingest" },
      connectors: [],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("stays uninitialised when the deployment has analytics off", async () => {
    stubRuntimeConfig({ analytics: null, connectors: [] });
    await import("../instrumentation-client");
    expect(posthog.init).not.toHaveBeenCalled();
  });

  it("stays uninitialised when the page carries no runtime config", async () => {
    stubRuntimeConfig(undefined);
    await import("../instrumentation-client");
    expect(posthog.init).not.toHaveBeenCalled();
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
        before_send: expect.any(Function),
      }),
    );
  });

  it("removes raw route and referrer data from every captured event", async () => {
    await import("../instrumentation-client");

    const config = posthog.init.mock.calls[0]?.[1] as {
      before_send: (capture: {
        uuid: string;
        event: string;
        properties: Record<string, unknown>;
        $set: Record<string, unknown>;
        $set_once: Record<string, unknown>;
      }) => unknown;
    };
    const token = "super-secret-invite-token";
    const capture = config.before_send({
      uuid: "event-1",
      event: "$pageview",
      properties: {
        $current_url: `https://comparative.example/invite/${token}?source=email`,
        $pathname: `/invite/${token}`,
        $prev_pageview_pathname: `/invite/${token}`,
        $referrer: `https://comparative.example/invite/${token}`,
        $referring_domain: "comparative.example",
        $initial_referring_domain: "comparative.example",
        $session_entry_url: `https://comparative.example/invite/${token}`,
        $session_entry_pathname: `/invite/${token}`,
      },
      $set: {
        $initial_referrer_info: {
          url: `https://comparative.example/invite/${token}`,
        },
      },
      $set_once: {
        $pathname: `/invite/${token}`,
        $referrer: `https://comparative.example/invite/${token}`,
      },
    });

    expect(capture).toMatchObject({
      properties: {
        $current_url: "https://comparative.example/invite/[token]",
        $pathname: "/invite/[token]",
        $prev_pageview_pathname: "/invite/[token]",
        $session_entry_url: "https://comparative.example/invite/[token]",
        $session_entry_pathname: "/invite/[token]",
      },
      $set_once: {
        $pathname: "/invite/[token]",
      },
    });
    expect(JSON.stringify(capture)).not.toContain(token);
    expect(JSON.stringify(capture)).not.toContain("referr");
  });
});
