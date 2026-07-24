import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClientApiError,
  fetchJson,
  readApiError,
} from "@/lib/client-api";

describe("client API errors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves the structured server envelope and prefers its message", async () => {
    const error = await readApiError(
      jsonResponse(
        {
          error: "invalid_schedule",
          field: "cadence",
          message: "Cadence must be hourly, daily, or weekly.",
        },
        400,
      ),
    );

    expect(error).toBeInstanceOf(ClientApiError);
    expect(error).toMatchObject({
      status: 400,
      code: "invalid_schedule",
      field: "cadence",
      message: "Cadence must be hourly, daily, or weekly.",
    });
  });

  it("humanizes a machine code when the server omits a message", async () => {
    const error = await readApiError(
      jsonResponse({ error: "skill_not_found" }, 404),
    );

    expect(error.message).toBe("Skill not found.");
    expect(error.code).toBe("skill_not_found");
  });

  it("uses caller context before a bare HTTP fallback", async () => {
    await expect(
      readApiError(new Response("bad gateway", { status: 502 })),
    ).resolves.toMatchObject({
      status: 502,
      message: "Request failed (HTTP 502).",
    });
    await expect(
      readApiError(
        new Response("bad gateway", { status: 502 }),
        "Could not load chats.",
      ),
    ).resolves.toMatchObject({
      status: 502,
      message: "Could not load chats.",
    });
  });

  it("fetches JSON and throws the same typed error contract", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ value: 42 }, 200))
      .mockResolvedValueOnce(
        jsonResponse({ error: "permission_denied" }, 403),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchJson<{ value: number }>("/api/example")).resolves.toEqual(
      { value: 42 },
    );
    await expect(fetchJson("/api/example")).rejects.toMatchObject({
      status: 403,
      code: "permission_denied",
      message: "Permission denied.",
    });
  });

  it("uses caller context when the request never reaches the server", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));

    await expect(
      fetchJson("/api/example", undefined, "Could not load examples."),
    ).rejects.toMatchObject({
      status: 0,
      message: "Could not load examples.",
    });
  });
});

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
