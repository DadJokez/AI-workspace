import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

/**
 * #780: `POST /api/schedules/[id]/run` is a thin shell over the shared
 * skill-run gates and `runScheduleNow`; this pins the HTTP contract — every
 * lib outcome maps to its status/body, the rate-limit gate short-circuits
 * before the lib runs, and a foreign id is a plain 404.
 */

const { requireSession, runScheduleNow, skillRunRateLimitResponse } =
  vi.hoisted(() => ({
    requireSession: vi.fn(),
    runScheduleNow: vi.fn(),
    skillRunRateLimitResponse: vi.fn(),
  }));

vi.mock("@/lib/auth/requireSession", () => ({ requireSession }));
vi.mock("@/lib/schedules/scheduler", () => ({ runScheduleNow }));
vi.mock("@/lib/skill-run-gates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/skill-run-gates")>();
  return { ...actual, skillRunRateLimitResponse };
});
vi.mock("@ai-workspace/db", () => ({ getDb: () => ({}) }));

import { POST } from "@/app/api/schedules/[id]/run/route";

const sessionUser = { id: "user-1", role: "user" };

function post(id = "schedule-1") {
  return POST(
    new Request(`http://localhost/api/schedules/${id}/run`, { method: "POST" }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  requireSession.mockResolvedValue({ user: sessionUser });
  skillRunRateLimitResponse.mockResolvedValue(null);
});

describe("POST /api/schedules/[id]/run", () => {
  it("returns 401 without a session and never reaches the lib", async () => {
    requireSession.mockResolvedValue({
      error: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    });

    const response = await post();

    expect(response.status).toBe(401);
    expect(skillRunRateLimitResponse).not.toHaveBeenCalled();
    expect(runScheduleNow).not.toHaveBeenCalled();
  });

  it("shares the skill-run rate-limit bucket and short-circuits on 429", async () => {
    skillRunRateLimitResponse.mockResolvedValue(
      NextResponse.json({ error: "rate_limited" }, { status: 429 }),
    );

    const response = await post();

    expect(response.status).toBe(429);
    expect(skillRunRateLimitResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: sessionUser.id,
        route: "/api/schedules/schedule-1/run",
      }),
    );
    expect(runScheduleNow).not.toHaveBeenCalled();
  });

  it("returns 404 for a schedule the caller does not own", async () => {
    runScheduleNow.mockResolvedValue({
      ok: false,
      status: 404,
      error: "schedule_not_found",
    });

    const response = await post("schedule-of-someone-else");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "schedule_not_found" });
    expect(runScheduleNow).toHaveBeenCalledWith({
      db: expect.anything(),
      actor: sessionUser,
      scheduleId: "schedule-of-someone-else",
    });
  });

  it("returns 409 with the message when a run is already in flight", async () => {
    runScheduleNow.mockResolvedValue({
      ok: false,
      status: 409,
      error: "run_in_flight",
      message: "A run for this schedule is already queued or running.",
    });

    const response = await post();

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "run_in_flight",
      message: "A run for this schedule is already queued or running.",
    });
  });

  it("renders provider gating with the same actionable body as the skill Run button", async () => {
    runScheduleNow.mockResolvedValue({
      ok: false,
      status: 409,
      error: "provider_access_required",
      access: {
        ready: [],
        missingConnections: ["google"],
        deniedAttestations: [],
        executionUnavailable: [],
        reconnectRequired: [],
        temporarilyUnavailable: [],
      },
    });

    const response = await post();

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "provider_access_required",
      message: expect.stringContaining("connect google in Settings → Integrations"),
      missingConnections: ["google"],
    });
  });

  it("returns 202 with the run and thread ids on success", async () => {
    runScheduleNow.mockResolvedValue({
      ok: true,
      runId: "run-1",
      threadId: "thread-1",
    });

    const response = await post();

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      runId: "run-1",
      threadId: "thread-1",
    });
  });
});
