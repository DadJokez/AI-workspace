import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  requireSession,
  listStandingToolApprovals,
  revokeStandingToolApproval,
} = vi.hoisted(() => ({
  requireSession: vi.fn(),
  listStandingToolApprovals: vi.fn(),
  revokeStandingToolApproval: vi.fn(),
}));

vi.mock("@/lib/auth/requireSession", () => ({ requireSession }));
vi.mock("@/lib/tool-approvals", () => ({
  listStandingToolApprovals,
  revokeStandingToolApproval,
}));
vi.mock("@ai-workspace/db", () => ({ getDb: () => ({}) }));

import { GET } from "@/app/api/skills/[id]/tool-approvals/route";
import { DELETE } from "@/app/api/skills/[id]/tool-approvals/[approvalId]/route";

const skillId = "00000000-0000-4000-8000-000000000410";
const approvalId = "00000000-0000-4000-8000-000000000411";

beforeEach(() => {
  vi.clearAllMocks();
  requireSession.mockResolvedValue({ user: { id: "user-1", role: "user" } });
});

describe("standing Skill approval routes", () => {
  it("lists only the caller's grants for the selected Skill", async () => {
    listStandingToolApprovals.mockResolvedValue([
      {
        id: approvalId,
        skillId,
        provider: "gmail",
        nativeToolName: "draft_email",
        expiresAt: "2026-09-14T12:00:00.000Z",
      },
    ]);

    const response = await GET(
      new Request(`http://localhost/api/skills/${skillId}/tool-approvals`),
      { params: Promise.resolve({ id: skillId }) },
    );

    expect(response.status).toBe(200);
    expect(listStandingToolApprovals).toHaveBeenCalledWith({
      db: {},
      userId: "user-1",
      skillId,
    });
    expect(await response.json()).toMatchObject({
      approvals: [{ id: approvalId }],
    });
  });

  it("revokes a caller-owned grant without exposing another user's rows", async () => {
    revokeStandingToolApproval.mockResolvedValue(true);

    const response = await DELETE(
      new Request(
        `http://localhost/api/skills/${skillId}/tool-approvals/${approvalId}`,
        { method: "DELETE" },
      ),
      { params: Promise.resolve({ id: skillId, approvalId }) },
    );

    expect(response.status).toBe(200);
    expect(revokeStandingToolApproval).toHaveBeenCalledWith({
      db: {},
      userId: "user-1",
      skillId,
      approvalId,
    });
  });

  it("rejects malformed ids before querying approval state", async () => {
    const listResponse = await GET(
      new Request("http://localhost/api/skills/nope/tool-approvals"),
      { params: Promise.resolve({ id: "nope" }) },
    );
    const revokeResponse = await DELETE(
      new Request("http://localhost/api/skills/nope/tool-approvals/nope", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "nope", approvalId: "nope" }) },
    );

    expect(listResponse.status).toBe(400);
    expect(revokeResponse.status).toBe(400);
    expect(listStandingToolApprovals).not.toHaveBeenCalled();
    expect(revokeStandingToolApproval).not.toHaveBeenCalled();
  });
});
