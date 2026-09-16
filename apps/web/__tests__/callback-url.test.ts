import { describe, expect, it } from "vitest";
import { sanitizeCallbackUrl } from "@/lib/auth/callback-url";

describe("login callback URL", () => {
  it.each([
    undefined, "", "https://other.invalid", "//other.invalid", "/\\other.invalid",
    "/\t/other.invalid", "/\n/other.invalid", "/\r/other.invalid", "/\0other",
    "/a/..//other.invalid", "/%2e//other.invalid",
  ])("rejects non-local or ambiguous destinations: %j", (raw) => {
    expect(sanitizeCallbackUrl(raw)).toBeNull();
  });

  it.each(["/chat", "/chat?threadId=abc&open=studio#files", "/invite/token", "/a%20b"]) (
    "preserves local destinations: %s", (raw) => {
      expect(sanitizeCallbackUrl(raw)).toBe(raw);
    },
  );

  it("validates decoded search parameters and normalizes dot segments", () => {
    const query = new URLSearchParams("callbackUrl=%2F%5Cother.invalid");
    expect(sanitizeCallbackUrl(query.get("callbackUrl")!)).toBeNull();
    expect(sanitizeCallbackUrl("/one/../chat")).toBe("/chat");
  });
});
