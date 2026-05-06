import { describe, expect, it } from "vitest";
import { classifyInvitation } from "@/lib/invitations";

/**
 * Pure-logic coverage for the four /invite/[token] outcomes. The page itself
 * is a thin wrapper that does a single DB lookup and forwards to this
 * classifier — exercising classifier branches here gives us the full state
 * matrix without spinning up Next.js.
 */

const now = new Date("2026-05-06T12:00:00Z");
const future = new Date("2026-05-13T12:00:00Z");
const past = new Date("2026-04-29T12:00:00Z");

describe("classifyInvitation", () => {
  it("returns not_found when no row exists for the token", () => {
    expect(classifyInvitation(undefined, now)).toEqual({ kind: "not_found" });
  });

  it("returns used when accepted_at is set, even if not expired", () => {
    const row = {
      acceptedAt: new Date("2026-05-05T12:00:00Z"),
      expiresAt: future,
      email: "x@y.com",
      role: "user" as const,
    };
    expect(classifyInvitation(row, now)).toEqual({ kind: "used" });
  });

  it("returns expired when expires_at is in the past and not accepted", () => {
    const row = {
      acceptedAt: null,
      expiresAt: past,
      email: "x@y.com",
      role: "user" as const,
    };
    expect(classifyInvitation(row, now)).toEqual({ kind: "expired" });
  });

  it("treats expires_at == now as expired (boundary)", () => {
    const row = {
      acceptedAt: null,
      expiresAt: now,
      email: "x@y.com",
      role: "user" as const,
    };
    expect(classifyInvitation(row, now)).toEqual({ kind: "expired" });
  });

  it("returns valid with email + role when not accepted and not expired", () => {
    const row = {
      acceptedAt: null,
      expiresAt: future,
      email: "alice@example.com",
      role: "admin" as const,
    };
    expect(classifyInvitation(row, now)).toEqual({
      kind: "valid",
      email: "alice@example.com",
      role: "admin",
    });
  });

  it("prefers used over expired when both apply", () => {
    const row = {
      acceptedAt: new Date("2026-05-05T12:00:00Z"),
      expiresAt: past,
      email: "x@y.com",
      role: "user" as const,
    };
    // Already-accepted is the more informative message — admin can see it
    // was successfully consumed, not just that the deadline lapsed.
    expect(classifyInvitation(row, now)).toEqual({ kind: "used" });
  });
});
