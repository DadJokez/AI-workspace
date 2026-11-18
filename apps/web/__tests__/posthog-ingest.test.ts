import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postHogUpstreamUrl } from "@/lib/posthog-ingest";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function enableAnalytics(host = "https://us.i.posthog.com") {
  vi.stubEnv("ANALYTICS_PROVIDER", "posthog");
  vi.stubEnv("POSTHOG_PROJECT_TOKEN", "phc_test");
  vi.stubEnv("POSTHOG_HOST", host);
}

async function route() {
  return import("@/app/ingest/[...path]/route");
}

const context = (path: string[]) => ({ params: Promise.resolve({ path }) });

describe("postHogUpstreamUrl", () => {
  it("sends events to the configured host with the query string", () => {
    expect(
      postHogUpstreamUrl("https://us.i.posthog.com", ["e"], "?ip=1&v=2"),
    ).toBe("https://us.i.posthog.com/e?ip=1&v=2");
  });

  it("sends PostHog Cloud static files to the assets host", () => {
    expect(
      postHogUpstreamUrl("https://eu.i.posthog.com", ["static", "array.js"], ""),
    ).toBe("https://eu-assets.i.posthog.com/static/array.js");
    expect(
      postHogUpstreamUrl("https://us.i.posthog.com", ["array", "k", "config"], ""),
    ).toBe("https://us-assets.i.posthog.com/array/k/config");
  });

  it("keeps a self-hosted host for static files", () => {
    expect(
      postHogUpstreamUrl("https://analytics.example.test", ["static", "a.js"], ""),
    ).toBe("https://analytics.example.test/static/a.js");
  });

  it("cannot be steered off the configured host by a path segment", () => {
    const url = new URL(
      postHogUpstreamUrl("https://us.i.posthog.com", ["..", "//evil.example"], ""),
    );
    expect(url.host).toBe("us.i.posthog.com");
  });
});

describe("/ingest route", () => {
  it("is 404 and sends nothing when analytics is off", async () => {
    vi.stubEnv("ANALYTICS_PROVIDER", "none");
    const { POST, GET } = await route();

    const post = await POST(
      new Request("https://comparative.example/ingest/e", {
        method: "POST",
        body: "{}",
      }),
      context(["e"]),
    );
    const get = await GET(
      new Request("https://comparative.example/ingest/static/array.js"),
      context(["static", "array.js"]),
    );

    expect(post.status).toBe(404);
    expect(get.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("proxies an event to the configured host without cookies or credentials", async () => {
    enableAnalytics();
    fetchMock.mockResolvedValue(
      new Response('{"status":1}', {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
          "set-cookie": "ph=1",
        },
      }),
    );
    const { POST } = await route();

    const res = await POST(
      new Request("https://comparative.example/ingest/e?ip=1", {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          cookie: "next-auth.session-token=secret",
          authorization: "Bearer secret",
        },
        body: "payload",
      }),
      context(["e"]),
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://us.i.posthog.com/e?ip=1");
    expect(init.method).toBe("POST");
    const sent = new Headers(init.headers);
    expect(sent.get("content-type")).toBe("text/plain");
    expect(sent.get("cookie")).toBeNull();
    expect(sent.get("authorization")).toBeNull();
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe("payload");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"status":1}');
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("answers 502 when the analytics host cannot be reached", async () => {
    enableAnalytics();
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const { GET } = await route();

    const res = await GET(
      new Request("https://comparative.example/ingest/static/array.js"),
      context(["static", "array.js"]),
    );

    expect(res.status).toBe(502);
  });
});
