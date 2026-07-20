import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The magic-link send seam: rendering, the SES call (mocked fetch — never a
 * real email), and the provider-disabled split (non-production logs the link
 * and no-ops; production fails loudly). Also proves the provider's
 * sendVerificationRequest hands next-auth's callback URL to this seam intact.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.restoreAllMocks();
});

const linkUrl =
  "http://localhost:3000/api/auth/callback/email?callbackUrl=%2Fchat&token=rawtoken123&email=tester%40example.com";

function stubSesEnv() {
  vi.stubEnv("INVITE_EMAIL_PROVIDER", "ses");
  vi.stubEnv("INVITE_EMAIL_FROM", "no-reply@comparative.example");
  vi.stubEnv("INVITE_EMAIL_AWS_REGION", "us-east-1");
  vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIDEXAMPLE");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secret");
}

describe("magic-link email rendering", () => {
  it("escapes the URL and recipient in HTML while keeping the link the whole message", async () => {
    const { renderMagicLinkHtml } = await import("@/lib/magic-link-email");
    const html = renderMagicLinkHtml({
      to: 'bad"><script>alert(1)</script>@example.com',
      url: "https://example.com/api/auth/callback/email?token=a&email=b",
      expires: new Date("2026-07-20T12:15:00Z"),
    });

    expect(html).toContain("Sign in to Comparative");
    expect(html).toContain(
      "https://example.com/api/auth/callback/email?token=a&amp;email=b",
    );
    expect(html).toContain("expires in 15 minutes and can be used once");
    expect(html).not.toContain('bad"><script>');
  });

  it("renders a plain-text fallback with the URL and single-use warning", async () => {
    const { renderMagicLinkText } = await import("@/lib/magic-link-email");
    const text = renderMagicLinkText({
      to: "tester@example.com",
      url: linkUrl,
      expires: new Date("2026-07-20T12:15:00Z"),
    });
    expect(text).toContain(linkUrl);
    expect(text).toContain("can be used once");
    expect(text).toContain("safely ignore");
  });
});

describe("sendMagicLinkEmail — SES seam", () => {
  it("POSTs the signed SES payload with the sign-in URL when the provider is enabled", async () => {
    stubSesEnv();
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ MessageId: "msg-123" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { sendMagicLinkEmail } = await import("@/lib/magic-link-email");
    const result = await sendMagicLinkEmail({
      to: "tester@example.com",
      url: linkUrl,
      expires: new Date(Date.now() + 15 * 60 * 1000),
    });

    expect(result).toEqual({ delivered: true, messageId: "msg-123" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchMock.mock.calls[0]! as unknown as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(endpoint).toBe(
      "https://email.us-east-1.amazonaws.com/v2/email/outbound-emails",
    );
    expect(init.headers.authorization).toContain("AWS4-HMAC-SHA256");
    const payload = JSON.parse(init.body) as {
      FromEmailAddress: string;
      Destination: { ToAddresses: string[] };
      Content: {
        Simple: {
          Subject: { Data: string };
          Body: { Text: { Data: string }; Html: { Data: string } };
        };
      };
    };
    expect(payload.FromEmailAddress).toBe("no-reply@comparative.example");
    expect(payload.Destination.ToAddresses).toEqual(["tester@example.com"]);
    expect(payload.Content.Simple.Subject.Data).toBe("Sign in to Comparative");
    expect(payload.Content.Simple.Body.Text.Data).toContain(linkUrl);
  });

  it("no-ops and logs the link when the provider is disabled outside production", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const { sendMagicLinkEmail } = await import("@/lib/magic-link-email");
    const result = await sendMagicLinkEmail({
      to: "tester@example.com",
      url: linkUrl,
      expires: new Date(),
    });

    expect(result).toEqual({ delivered: false, messageId: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining(linkUrl));
  });

  it("throws in production when the provider is disabled — no silent 'link on its way' lie", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { sendMagicLinkEmail } = await import("@/lib/magic-link-email");
    await expect(
      sendMagicLinkEmail({
        to: "tester@example.com",
        url: linkUrl,
        expires: new Date(),
      }),
    ).rejects.toMatchObject({ code: "email_provider_disabled" });
  });
});

describe("email provider sendVerificationRequest wiring", () => {
  it("passes next-auth's identifier and URL straight to the send seam", async () => {
    const send = vi.fn(async () => ({ delivered: true, messageId: "m" }));
    vi.doMock("@/lib/magic-link-email", async () => {
      const actual = await vi.importActual<
        typeof import("@/lib/magic-link-email")
      >("@/lib/magic-link-email");
      return { ...actual, sendMagicLinkEmail: send };
    });

    const { authOptions } = await import("@/lib/auth/nextauth");
    const email = authOptions.providers.find(
      (p) => p.id === "email",
    ) as unknown as {
      sendVerificationRequest: (params: {
        identifier: string;
        url: string;
        expires: Date;
        token: string;
        provider: unknown;
        theme: unknown;
      }) => Promise<void>;
    };

    const expires = new Date(Date.now() + 15 * 60 * 1000);
    await email.sendVerificationRequest({
      identifier: "tester@example.com",
      url: linkUrl,
      expires,
      token: "rawtoken123",
      provider: {},
      theme: {},
    });

    expect(send).toHaveBeenCalledWith({
      to: "tester@example.com",
      url: linkUrl,
      expires,
    });
  });
});
