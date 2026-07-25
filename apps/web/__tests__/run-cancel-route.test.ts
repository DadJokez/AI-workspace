import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #655: the cancel route must pass the typed cancel outcome through to the
 * client — the Stop flow branches on it to avoid claiming a cancellation when
 * the durable answer already committed.
 */

const { requireSession, cancelRun } = vi.hoisted(() => ({
  requireSession: vi.fn(),
  cancelRun: vi.fn(),
}));

vi.mock("@/lib/auth/requireSession", () => ({ requireSession }));
vi.mock("@/lib/run-actions", () => ({ cancelRun }));
vi.mock("@ai-workspace/db", () => ({ getDb: () => ({}) }));
vi.mock("@ai-workspace/auth", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

import { UnauthorizedError } from "@ai-workspace/auth";
import { POST } from "@/app/api/runs/[id]/cancel/route";

const sessionUser = { id: "user-1", role: "user" };

function post(id = "run-1") {
  return POST(new Request(`http://localhost/api/runs/${id}/cancel`), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireSession.mockResolvedValue({ user: sessionUser });
});

describe("POST /api/runs/[id]/cancel", () => {
  it.each([
    ["canceled", "canceled"],
    ["already_canceled", "canceled"],
    ["already_terminal", "succeeded"],
    ["result_committed", "running"],
  ] as const)("returns 200 with outcome %s", async (outcome, status) => {
    cancelRun.mockResolvedValue({
      ok: true,
      outcome,
      run: { id: "run-1", status },
    });

    const response = await post();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      run: { id: "run-1", status },
      outcome,
    });
    expect(cancelRun).toHaveBeenCalledWith(
      expect.objectContaining({ actor: sessionUser, runId: "run-1" }),
    );
  });

  it("maps action failures onto their HTTP status and error body", async () => {
    cancelRun.mockResolvedValue({
      ok: false,
      status: 404,
      error: "run_not_found",
      message: "The run was not found.",
    });

    const response = await post("run-missing");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "run_not_found",
      message: "The run was not found.",
    });
  });

  it("returns 401 when the session is unauthorized", async () => {
    requireSession.mockRejectedValue(new UnauthorizedError("no session"));

    const response = await post();

    expect(response.status).toBe(401);
    expect(cancelRun).not.toHaveBeenCalled();
  });
});
