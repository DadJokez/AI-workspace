import { describe, expect, it, vi } from "vitest";
import { ensureGitHubRepositoryWebhookWithToken } from "@/lib/github-webhook-subscriptions";

const input = {
  accessToken: "github-user-token",
  repository: "dadjokez/ai-workspace",
  webhookUrl: "https://comparative.example/api/webhooks/github",
  secret: "shared-webhook-secret",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GitHub repository webhook provisioning", () => {
  it("installs a signed webhook when the repository has none", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(
        json(
          {
            id: 293,
            active: true,
            events: ["pull_request_review", "workflow_run"],
            config: { url: input.webhookUrl },
          },
          201,
        ),
      );

    const result = await ensureGitHubRepositoryWebhookWithToken({
      ...input,
      fetchImpl,
    });

    expect(result).toEqual({ ok: true, hookId: 293, created: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/dadjokez/ai-workspace/hooks",
    );
    const createRequest = fetchImpl.mock.calls[1]?.[1];
    expect(createRequest?.method).toBe("POST");
    expect(JSON.parse(String(createRequest?.body))).toMatchObject({
      name: "web",
      active: true,
      events: ["pull_request_review", "workflow_run"],
      config: {
        url: input.webhookUrl,
        content_type: "json",
        secret: input.secret,
      },
    });
  });

  it("refreshes the shared secret and event list on an existing hook", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json([
          {
            id: 99,
            active: false,
            events: ["pull_request_review"],
            config: { url: input.webhookUrl },
          },
        ]),
      )
      .mockResolvedValueOnce(
        json({
          id: 99,
          active: true,
          events: ["pull_request_review", "workflow_run"],
          config: { url: input.webhookUrl },
        }),
      );

    const result = await ensureGitHubRepositoryWebhookWithToken({
      ...input,
      fetchImpl,
    });

    expect(result).toEqual({ ok: true, hookId: 99, created: false });
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      "https://api.github.com/repos/dadjokez/ai-workspace/hooks/99",
    );
    expect(fetchImpl.mock.calls[1]?.[1]?.method).toBe("PATCH");
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toMatchObject({
      active: true,
      events: ["pull_request_review", "workflow_run"],
      config: { secret: input.secret },
    });
  });

  it("returns an actionable boundary when the user lacks repository admin", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({}, 403));

    const result = await ensureGitHubRepositoryWebhookWithToken({
      ...input,
      fetchImpl,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 403,
      error: "github_repository_admin_required",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("asks for reconnection when GitHub rejects the OAuth token", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({}, 401));

    const result = await ensureGitHubRepositoryWebhookWithToken({
      ...input,
      fetchImpl,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: "github_reconnect_required",
    });
  });
});
