import { beforeEach, expect, it, vi } from "vitest";

const { getSessionUser, redirect } = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  redirect: vi.fn(() => { throw new Error("redirect"); }),
}));
vi.mock("@/lib/auth/getSessionUser", () => ({ getSessionUser }));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/auth/nextauth", () => ({ enabledAuthProviders: () => [] }));
vi.mock("@/components/AlphaBadge", () => ({ AlphaBadge: () => null }));
vi.mock("@/components/ThemeToggle", () => ({ ThemeToggle: () => null }));
vi.mock("@/components/ThinkingOrb", () => ({ ThinkingOrb: () => null }));
vi.mock("@/app/login/LoginForm", () => ({ LoginForm: () => null }));
import LoginPage from "@/app/login/page";

beforeEach(() => {
  vi.clearAllMocks();
  getSessionUser.mockResolvedValue({ id: "viewer" });
});

it.each(["/\\elsewhere.invalid", "/\t/elsewhere.invalid", "/a/..//elsewhere.invalid"])(
  "signed-in login falls back safely for %j", async (callbackUrl) => {
    await expect(LoginPage({ searchParams: Promise.resolve({ callbackUrl }) })).rejects.toThrow("redirect");
    expect(redirect).toHaveBeenCalledWith("/chat");
  },
);

it("signed-in login retains the intended local destination", async () => {
  const callbackUrl = "/chat?threadId=abc&open=studio";
  await expect(LoginPage({ searchParams: Promise.resolve({ callbackUrl }) })).rejects.toThrow("redirect");
  expect(redirect).toHaveBeenCalledWith(callbackUrl);
});
