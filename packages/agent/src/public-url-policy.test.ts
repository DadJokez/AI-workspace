import { describe, expect, it, vi } from "vitest";
import {
  assertPublicUrlAllowed,
  createPublicLookup,
  isBlockedPublicTarget,
  parsePublicHttpUrl,
  publicUrlReceipt,
  resolvePublicAddresses,
} from "./public-url-policy";

describe("public URL policy", () => {
  it("accepts public http(s) URLs and strips sensitive receipt fields", () => {
    expect(parsePublicHttpUrl("https://example.com/path").hostname).toBe(
      "example.com",
    );
    expect(
      publicUrlReceipt("https://example.com/path?token=secret#section"),
    ).toEqual({
      origin: "https://example.com",
      displayUrl: "https://example.com/path",
    });
  });

  it("rejects credentials and unsupported schemes", () => {
    expect(() => parsePublicHttpUrl("file:///etc/passwd")).toThrow(
      /Only public http\(s\)/,
    );
    expect(() => parsePublicHttpUrl("https://user:pass@example.com")).toThrow(
      /Embedded credentials/,
    );
    expect(() => parsePublicHttpUrl("https://example.com:8443")).toThrow(
      /port 8443 is not allowed/,
    );
    expect(() => parsePublicHttpUrl("http://example.com:443")).toThrow(
      /port 443 is not allowed/,
    );
    expect(() => parsePublicHttpUrl("https://example.com:80")).toThrow(
      /port 80 is not allowed/,
    );
  });

  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.10",
    "240.0.0.1",
    "255.255.255.255",
    "::1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ])("blocks private or reserved target %s", (address) => {
    expect(isBlockedPublicTarget(address)).toBe(true);
  });

  it("denies localhost and DNS answers containing any private address", async () => {
    await expect(resolvePublicAddresses("localhost")).rejects.toThrow(
      /private hostname/,
    );
    const lookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.7", family: 4 },
    ]);
    await expect(
      resolvePublicAddresses("rebinding.example", lookup as never),
    ).rejects.toThrow(/private or reserved address/);
  });

  it("re-resolves on each socket lookup so rebinding is denied", async () => {
    const lookup = vi
      .fn()
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const guarded = createPublicLookup(lookup as never);

    await new Promise<void>((resolve, reject) => {
      guarded("example.com", {}, (error, address) => {
        if (error) reject(error);
        else {
          expect(address).toBe("93.184.216.34");
          resolve();
        }
      });
    });
    await expect(
      new Promise<void>((resolve, reject) => {
        guarded("example.com", {}, (error) =>
          error ? reject(error) : resolve(),
        );
      }),
    ).rejects.toThrow(/private or reserved address/);
  });

  it("applies the workspace denylist before navigation", async () => {
    await expect(
      assertPublicUrlAllowed({
        url: new URL("https://sub.example.com/path"),
        egressPolicy: {
          name: "admin_domain_denylist",
          deniedDomains: ["example.com"],
        },
      }),
    ).rejects.toThrow(/web_egress_denied/);
  });
});
