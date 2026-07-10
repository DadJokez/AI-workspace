import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "test-github-webhook-secret";
const DELIVERY_ID = "00000000-0000-4000-8000-000000000293";
const calls: Array<{ fn: string; args: unknown[] }> = [];
let processResult = {
  matched: 1,
  fired: 1,
  blocked: 0,
  duplicate: 0,
  failed: 0,
};

const payload = {
  action: "submitted",
  repository: { full_name: "DadJokez/AI-workspace" },
  pull_request: {
    number: 293,
    title: "Add GitHub event triggers",
    html_url: "https://github.com/DadJokez/AI-workspace/pull/293",
    user: { login: "author-user" },
    assignees: [{ login: "roblindmark" }],
  },
  review: {
    state: "approved",
    body: "Looks good.",
    html_url: "https://github.com/DadJokez/AI-workspace/pull/293#review",
    user: { login: "reviewer-user" },
  },
};

function installMocks() {
  vi.doMock("@ai-workspace/db", async () => {
    const actual =
      await vi.importActual<typeof import("@ai-workspace/db")>(
        "@ai-workspace/db",
      );
    return { ...actual, getDb: () => ({ id: "mock-db" }) as never };
  });
  vi.doMock("@/lib/github-event-triggers", async () => {
    const actual =
      await vi.importActual<typeof import("@/lib/github-event-triggers")>(
        "@/lib/github-event-triggers",
      );
    return {
      ...actual,
      processGitHubWebhookEvent: async (...args: unknown[]) => {
        calls.push({ fn: "process", args });
        return processResult;
      },
      writeGitHubWebhookAudit: async (...args: unknown[]) => {
        calls.push({ fn: "audit", args });
      },
    };
  });
}

function requestFor(
  body: string,
  options: { signature?: string; eventType?: string } = {},
) {
  const signature =
    options.signature ??
    `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
  return new Request("http://localhost/api/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": DELIVERY_ID,
      "x-github-event": options.eventType ?? "pull_request_review",
      "x-hub-signature-256": signature,
    },
    body,
  });
}

beforeEach(() => {
  calls.length = 0;
  processResult = {
    matched: 1,
    fired: 1,
    blocked: 0,
    duplicate: 0,
    failed: 0,
  };
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", SECRET);
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe("POST /api/webhooks/github", () => {
  it("rejects an invalid signature before parsing or processing the event", async () => {
    installMocks();
    const { POST } = await import("@/app/api/webhooks/github/route");
    const response = await POST(
      requestFor(JSON.stringify(payload), {
        signature: `sha256=${"0".repeat(64)}`,
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_signature",
    });
    expect(calls.some((call) => call.fn === "process")).toBe(false);
    expect(calls.find((call) => call.fn === "audit")?.args[0]).toMatchObject({
      deliveryId: DELIVERY_ID,
      status: "denied",
    });
  });

  it("normalizes and processes a signed supported event", async () => {
    installMocks();
    const { POST } = await import("@/app/api/webhooks/github/route");
    const response = await POST(requestFor(JSON.stringify(payload)));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      matched: 1,
      fired: 1,
    });
    const processCall = calls.find((call) => call.fn === "process");
    expect(processCall?.args[0]).toMatchObject({
      deliveryId: DELIVERY_ID,
      event: {
        repository: "dadjokez/ai-workspace",
        eventType: "pull_request_review",
      },
    });
  });

  it("returns a retryable error when a matching trigger fails", async () => {
    processResult = {
      matched: 1,
      fired: 0,
      blocked: 0,
      duplicate: 0,
      failed: 1,
    };
    installMocks();
    const { POST } = await import("@/app/api/webhooks/github/route");
    const response = await POST(requestFor(JSON.stringify(payload)));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      failed: 1,
    });
  });

  it("accepts GitHub ping without creating a run", async () => {
    installMocks();
    const { POST } = await import("@/app/api/webhooks/github/route");
    const response = await POST(
      requestFor(JSON.stringify({ zen: "Keep it logically awesome." }), {
        eventType: "ping",
      }),
    );

    expect(response.status).toBe(202);
    expect(calls.some((call) => call.fn === "process")).toBe(false);
  });
});
