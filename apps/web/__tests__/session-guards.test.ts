import {
  AuthConfigError,
  UnauthorizedError,
  type SessionUser,
} from "@ai-workspace/auth";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getSessionUser = vi.fn();

vi.mock("@/lib/auth/getSessionUser", () => ({ getSessionUser }));

const user: SessionUser = {
  id: "user-id",
  email: "user@example.com",
  displayName: "User",
  role: "user",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requireSession", () => {
  it("returns the resolved session user", async () => {
    getSessionUser.mockResolvedValue(user);
    const { requireSession } = await import("@/lib/auth/requireSession");

    await expect(requireSession()).resolves.toEqual({ user });
  });

  it("returns the shared unauthorized envelope for an absent session", async () => {
    getSessionUser.mockResolvedValue(null);
    const { requireSession } = await import("@/lib/auth/requireSession");

    const result = await requireSession();

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(401);
      await expect(result.error.json()).resolves.toEqual({
        error: "unauthorized",
      });
    }
  });

  it("normalizes auth-layer unauthorized errors", async () => {
    getSessionUser.mockRejectedValue(new UnauthorizedError());
    const { requireSession } = await import("@/lib/auth/requireSession");

    const result = await requireSession();

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(401);
      await expect(result.error.json()).resolves.toEqual({
        error: "unauthorized",
      });
    }
  });

  it("preserves structured auth-configuration failures", async () => {
    getSessionUser.mockRejectedValue(new AuthConfigError("missing secret"));
    const { requireSession } = await import("@/lib/auth/requireSession");

    const result = await requireSession();

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(500);
      await expect(result.error.json()).resolves.toEqual({
        error: "auth_config_error",
        message: "missing secret",
      });
    }
  });

  it("does not hide unexpected failures", async () => {
    const failure = new Error("database unavailable");
    getSessionUser.mockRejectedValue(failure);
    const { requireSession } = await import("@/lib/auth/requireSession");

    await expect(requireSession()).rejects.toBe(failure);
  });
});

describe("requireAdmin", () => {
  it("rejects a non-admin session without changing the session contract", async () => {
    getSessionUser.mockResolvedValue(user);
    const { requireAdmin } = await import("@/lib/auth/requireAdmin");

    const result = await requireAdmin();

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.status).toBe(403);
      await expect(result.error.json()).resolves.toEqual({
        error: "forbidden",
      });
    }
  });
});

describe("API route session guard contract", () => {
  it("keeps direct session resolution out of API route handlers", () => {
    const apiRoot = join(process.cwd(), "app", "api");
    const offenders = collectRouteFiles(apiRoot).filter((file) =>
      readFileSync(file, "utf8").includes("getSessionUser"),
    );

    expect(offenders).toEqual([]);
  });
});

function collectRouteFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectRouteFiles(path);
    return entry.name === "route.ts" ? [path] : [];
  });
}
